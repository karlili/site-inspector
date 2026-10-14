import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestDatabase } from '../db/testing'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-inspector-jobs-'))
process.env.DATA_DIR = tmp
const dropDatabase = await createTestDatabase()

const { db, openDb, closeDb } = await import('../db/client')
const { crawls, links, pages, settings } = await import('../db/schema')
const jobs = await import('./jobs')
const { getRunnerSettings, saveRunnerSettings } = await import('./settings')
const { DEFAULT_RUNNER_SETTINGS, crawlNameSchema } = await import('#/lib/schemas')
const { LEASE_MS, MAX_ATTEMPTS } = jobs

/** Extra pools tests open, closed with the main one before the database is dropped. */
const pools: ReturnType<typeof openDb>[] = []

afterAll(async () => {
  await Promise.all([db, ...pools].map(closeDb))
  await dropDatabase()
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Override some runner settings; tests run without a fetch delay unless they set one. */
const configure = (overrides: Partial<typeof DEFAULT_RUNNER_SETTINGS> = {}) =>
  saveRunnerSettings(db, { ...DEFAULT_RUNNER_SETTINGS, fetchDelayMs: 0, ...overrides })

beforeEach(async () => {
  await db.delete(crawls)
  await configure()
})

const ROOT = 'https://example.test/'
const url = (p: string) => new URL(p, ROOT).href

function newCrawl(opts: { maxDepth?: number; maxPages?: number } = {}) {
  return jobs.createCrawl(db, {
    rootUrl: ROOT,
    maxDepth: opts.maxDepth ?? 2,
    maxPages: opts.maxPages ?? 100,
    viewports: ['desktop'],
    respectRobots: false,
  })
}

const result = (discoveredUrls: string[] = [], error: string | null = null) => ({
  httpStatus: 200,
  title: null,
  error,
  discoveredUrls,
  screenshots: [],
})

/** Claim the root page and complete it with the given links. */
async function finishRoot(runnerId: string, children: string[]) {
  const job = (await jobs.claimNextPage(db, runnerId))!
  expect(job.page.depth).toBe(0)
  expect(await jobs.completePage(db, runnerId, job, result(children))).toBe(true)
}

const crawlRow = async (id: string) => (await db.select().from(crawls).where(eq(crawls.id, id)))[0]
const pageRows = (id: string) => db.select().from(pages).where(eq(pages.crawlId, id)).orderBy(pages.seq)

describe('crawl job queue', () => {
  it('hands each page to exactly one of several competing processes', async () => {
    const crawlId = await newCrawl({ maxDepth: 1, maxPages: 1000 })
    await finishRoot('seed', Array.from({ length: 200 }, (_, i) => url(`/p${i}`)))

    // Each child process claims and completes pages until the queue is empty.
    const script = `
      ;(async () => {
        const { closeDb, openDb } = await import('#/server/db/client')
        const { claimNextPage, completePage } = await import('#/server/crawler/jobs')
        const db = openDb()
        const id = process.argv.at(-1)
        const claimed = []
        let job
        while ((job = await claimNextPage(db, id))) {
          claimed.push(job.page.id)
          await completePage(db, id, job, { httpStatus: 200, title: null, error: null, discoveredUrls: [], screenshots: [] })
        }
        await closeDb(db)
        console.log(JSON.stringify(claimed))
      })()`
    const tsx = path.resolve('node_modules/.bin/tsx')
    const outputs = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        promisify(execFile)(tsx, ['--eval', script, '--', `proc-${i}`], { env: process.env }),
      ),
    )
    const claimed = outputs.flatMap(({ stdout }) => JSON.parse(stdout.trim().split('\n').at(-1)!))

    expect(claimed).toHaveLength(200)
    expect(new Set(claimed).size).toBe(200)
    expect((await crawlRow(crawlId)).status).toBe('done')
  })

  it('limits pages in flight per crawl', async () => {
    await newCrawl()
    await finishRoot('r', Array.from({ length: 10 }, (_, i) => url(`/p${i}`)))
    const other = openDb()
    pools.push(other)
    const claimed = []
    for (let i = 0; i < 10; i++) {
      const job = await jobs.claimNextPage(i % 2 ? db : other, `r${i % 2}`)
      if (job) claimed.push(job)
    }
    expect(claimed).toHaveLength(DEFAULT_RUNNER_SETTINGS.maxInFlightPerCrawl)
  })

  it('takes the in-flight limit from settings', async () => {
    await configure({ maxInFlightPerCrawl: 2 })
    await newCrawl()
    await finishRoot('r', Array.from({ length: 10 }, (_, i) => url(`/p${i}`)))
    const claimed = []
    for (let i = 0; i < 10; i++) claimed.push(await jobs.claimNextPage(db, 'r'))
    claimed.splice(0, claimed.length, ...claimed.filter(Boolean))
    expect(claimed).toHaveLength(2)
    expect(claimed[0]!.settings.maxInFlightPerCrawl).toBe(2)
  })

  it('spaces out page loads of a crawl by the fetch delay', async () => {
    await configure({ fetchDelayMs: 2000 })
    const crawlId = await newCrawl()
    const t = Date.now()
    const root = (await jobs.claimNextPage(db, 'r', t))!
    expect(await jobs.completePage(db, 'r', root, result([url('/a'), url('/b')]))).toBe(true)

    // The root finished early, but its children wait out the delay...
    expect(await jobs.claimNextPage(db, 'r', t + 1999)).toBeNull()
    // ...while another crawl isn't held up by it.
    const other = await newCrawl()
    expect((await jobs.claimNextPage(db, 'r', t + 1999))!.crawl.id).toBe(other)

    const a = (await jobs.claimNextPage(db, 'r', t + 2000))!
    expect(a.crawl.id).toBe(crawlId)
    expect(a.crawl.nextFetchAt).toEqual(new Date(t + 4000))
    // Spaced from the last claim even while that page is still loading.
    expect(await jobs.claimNextPage(db, 'r', t + 3999)).toBeNull()
    expect((await jobs.claimNextPage(db, 'r', t + 4000))!.page.url).toBe(url('/b'))
  })

  it.each([true, false])('uses a longer robots.txt Crawl-delay when honoring it is %s', async (honor) => {
    await configure({ fetchDelayMs: 1000, honorCrawlDelay: honor })
    const crawlId = await newCrawl()
    const t = Date.now()
    const root = (await jobs.claimNextPage(db, 'r', t))!
    await jobs.completePage(db, 'r', root, {
      ...result([url('/a'), url('/b')]),
      hostname: 'example.test',
      robotsTxt: 'User-agent: *\nCrawl-delay: 5',
    })
    expect((await crawlRow(crawlId)).crawlDelayMs).toBe(5000)

    expect(await jobs.claimNextPage(db, 'r', t + 1000)).not.toBeNull()
    const next = await jobs.claimNextPage(db, 'r', t + 2000)
    if (honor) {
      expect(next).toBeNull()
      expect(await jobs.claimNextPage(db, 'r', t + 6000)).not.toBeNull()
    } else {
      expect(next).not.toBeNull()
    }
  })

  it('caps the Crawl-delay it will wait for', async () => {
    const crawlId = await newCrawl()
    const root = (await jobs.claimNextPage(db, 'r'))!
    await jobs.completePage(db, 'r', root, {
      ...result(),
      hostname: 'example.test',
      robotsTxt: 'User-agent: *\nCrawl-delay: 3600',
    })
    expect((await crawlRow(crawlId)).crawlDelayMs).toBe(jobs.MAX_CRAWL_DELAY_MS)
  })

  it('finishes a depth level before handing out the next', async () => {
    const crawlId = await newCrawl()
    await finishRoot('r', [url('/a'), url('/b')])
    const a = (await jobs.claimNextPage(db, 'r'))!
    const b = (await jobs.claimNextPage(db, 'r'))!
    expect(await jobs.completePage(db, 'r', a, result([url('/a/1'), url('/b')]))).toBe(true)

    // /b is still being captured, so /a/1 has to wait.
    expect(await jobs.claimNextPage(db, 'r')).toBeNull()
    expect(await jobs.completePage(db, 'r', b, result([url('/a/1')]))).toBe(true)
    const deep = (await jobs.claimNextPage(db, 'r'))!
    expect(deep.page.url).toBe(url('/a/1'))
    expect(deep.page.depth).toBe(2)
    expect(deep.page.parentPageId).toBe(a.page.id)

    // Links point at pages whichever level they were found on; /a -> /b is a cross-link.
    const edges = await db.select().from(links).where(eq(links.crawlId, crawlId))
    expect(edges).toContainEqual(
      expect.objectContaining({ fromPageId: a.page.id, toPageId: b.page.id }),
    )
    expect(edges).toContainEqual(
      expect.objectContaining({ fromPageId: b.page.id, toPageId: deep.page.id }),
    )

    expect(await jobs.completePage(db, 'r', deep, result([url('/a/1/x')]))).toBe(true)
    // maxDepth 2: /a/1's links aren't followed, and the crawl is finished.
    expect(await pageRows(crawlId)).toHaveLength(4)
    expect((await crawlRow(crawlId)).status).toBe('done')
  })

  it('stops adding pages at maxPages', async () => {
    const crawlId = await newCrawl({ maxPages: 3 })
    await finishRoot('r', [url('/a'), url('/b'), url('/c'), url('/d')])
    expect(await pageRows(crawlId)).toHaveLength(3)
    expect((await crawlRow(crawlId)).pageCount).toBe(3)
  })

  it('requeues pages whose runner disappeared, then gives up on them', async () => {
    const crawlId = await newCrawl()
    let now = Date.now()
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const job = (await jobs.claimNextPage(db, `dead-${attempt}`, now))!
      expect(job.page.attempts).toBe(attempt)
      // A heartbeat keeps the claim alive...
      await jobs.heartbeat(db, `dead-${attempt}`, [job.page.id], now + LEASE_MS / 2)
      expect(await jobs.reapExpiredLeases(db, now + LEASE_MS + 1)).toBe(0)
      // ...but once it stops, the page is reaped.
      now += 2 * LEASE_MS
      expect(await jobs.reapExpiredLeases(db, now)).toBe(1)
      // The lost runner can no longer report a result.
      expect(await jobs.completePage(db, `dead-${attempt}`, job, result())).toBe(false)
    }
    const [root] = await pageRows(crawlId)
    expect(root.status).toBe('failed')
    // The root page failing fails the crawl.
    expect(await crawlRow(crawlId)).toMatchObject({ status: 'failed', error: 'Runner lost while capturing' })
  })

  it('drops results for cancelled crawls', async () => {
    const crawlId = await newCrawl()
    await finishRoot('r', [url('/a'), url('/b')])
    const a = (await jobs.claimNextPage(db, 'r'))!
    expect(await jobs.isCrawlActive(db, crawlId)).toBe(true)

    expect(await jobs.cancelCrawl(db, crawlId)).toBe(true)
    expect(await jobs.isCrawlActive(db, crawlId)).toBe(false)
    expect(await jobs.completePage(db, 'r', a, result([url('/c')]))).toBe(false)
    expect(await jobs.claimNextPage(db, 'r')).toBeNull()
    expect((await crawlRow(crawlId)).status).toBe('cancelled')
    const open = (await pageRows(crawlId)).filter((p) => p.depth > 0)
    expect(open.every((p) => p.status === 'cancelled' && p.error === 'Crawl cancelled')).toBe(true)
    expect(await jobs.cancelCrawl(db, crawlId)).toBe(false)
  })

  it('serves the oldest crawl first', async () => {
    const first = await newCrawl()
    const second = await newCrawl()
    expect((await jobs.claimNextPage(db, 'r'))!.crawl.id).toBe(first)
    // The first crawl is blocked on its root, so a free slot moves on to the next one.
    expect((await jobs.claimNextPage(db, 'r'))!.crawl.id).toBe(second)
  })
})

const pageAt = async (crawlId: string, path: string) => (await pageRows(crawlId)).find((p) => p.url === url(path))!
const linkPairs = async (crawlId: string) => {
  const byId = new Map((await pageRows(crawlId)).map((p) => [p.id, new URL(p.url).pathname]))
  return (await db.select().from(links).where(eq(links.crawlId, crawlId)))
    .map((l) => `${byId.get(l.fromPageId)}>${byId.get(l.toPageId)}`)
    .sort()
}

/** Claim and complete pages until none are left; `linksOf` gives what each page links to. */
async function drain(linksOf: Record<string, string[]> = {}) {
  const captured: string[] = []
  let job
  while ((job = await jobs.claimNextPage(db, 'r'))) {
    const p = new URL(job.page.url).pathname
    captured.push(p)
    expect(await jobs.completePage(db, 'r', job, result((linksOf[p] ?? []).map(url)))).toBe(true)
  }
  return captured
}

describe('refetch, go deeper and resume', () => {
  it('refetches a page of a finished crawl, replacing its links', async () => {
    const crawlId = await newCrawl({ maxDepth: 1 })
    await finishRoot('r', [url('/a'), url('/b')])
    await drain()
    expect((await crawlRow(crawlId)).status).toBe('done')
    const root = await pageAt(crawlId, '/')

    expect(await jobs.refetchPage(db, crawlId, root.id)).toBe(true)
    expect(await crawlRow(crawlId)).toMatchObject({ status: 'queued', finishedAt: null })
    expect(await pageAt(crawlId, '/')).toMatchObject({ status: 'pending', attempts: 0 })
    // Already waiting for a runner.
    expect(await jobs.refetchPage(db, crawlId, root.id)).toBe(false)

    expect(await drain({ '/': ['/a', '/c'] })).toEqual(['/', '/c'])
    expect((await crawlRow(crawlId)).status).toBe('done')
    expect(await linkPairs(crawlId)).toEqual(['/>/a', '/>/c'])
    // The page it no longer links to stays on the board.
    expect((await pageAt(crawlId, '/b')).status).toBe('done')
  })

  it('keeps the links of pages at the depth limit without crawling them', async () => {
    const crawlId = await newCrawl({ maxDepth: 1 })
    await finishRoot('r', [url('/a')])
    await drain({ '/a': ['/x', '/y'] })
    expect((await pageAt(crawlId, '/a')).outlinks).toEqual([url('/x'), url('/y')])
    expect(await pageRows(crawlId)).toHaveLength(2)
  })

  it('goes deeper below a page from the links it already found', async () => {
    const crawlId = await newCrawl({ maxDepth: 1 })
    await finishRoot('r', [url('/a'), url('/b')])
    await drain({ '/a': ['/x'], '/b': ['/x', '/y'] })
    const a = await pageAt(crawlId, '/a')

    expect(await jobs.expandPage(db, crawlId, a.id, 2)).toEqual({ queued: 1 })
    expect(await crawlRow(crawlId)).toMatchObject({ status: 'queued', maxDepth: 1 })
    expect(await pageAt(crawlId, '/x')).toMatchObject({ depth: 2, parentPageId: a.id, expandToDepth: 3 })
    // /b linked to /x before it existed; that link is filled in too.
    expect(await linkPairs(crawlId)).toContain('/b>/x')

    // Two levels: /x's links are crawled, theirs are not.
    expect(await drain({ '/x': ['/z'], '/z': ['/w'] })).toEqual(['/x', '/z'])
    expect((await pageAt(crawlId, '/z')).depth).toBe(3)
    expect((await pageRows(crawlId)).some((p) => p.url === url('/w'))).toBe(false)
    // /b's branch wasn't expanded.
    expect((await pageRows(crawlId)).some((p) => p.url === url('/y'))).toBe(false)
    expect((await crawlRow(crawlId)).status).toBe('done')
  })

  it('goes deeper across the whole crawl from the root page', async () => {
    const crawlId = await newCrawl({ maxDepth: 1 })
    await finishRoot('r', [url('/a'), url('/b')])
    await drain({ '/a': ['/x'], '/b': ['/y'] })

    expect(await jobs.expandPage(db, crawlId, (await pageAt(crawlId, '/')).id, 1)).toEqual({ queued: 2 })
    expect((await crawlRow(crawlId)).maxDepth).toBe(2)
    expect((await drain()).sort()).toEqual(['/x', '/y'])
  })

  it('ignores the page limit when going deeper', async () => {
    const crawlId = await newCrawl({ maxDepth: 1, maxPages: 2 })
    await finishRoot('r', [url('/a'), url('/b')])
    await drain({ '/a': ['/x', '/y', '/z'] })
    expect(await pageRows(crawlId)).toHaveLength(2)

    expect(await jobs.expandPage(db, crawlId, (await pageAt(crawlId, '/a')).id, 1)).toEqual({ queued: 3 })
    expect((await crawlRow(crawlId)).pageCount).toBe(5)
  })

  it('recaptures pages whose links were never kept before going deeper', async () => {
    const crawlId = await newCrawl({ maxDepth: 1 })
    await finishRoot('r', [url('/a')])
    await drain()
    const a = await pageAt(crawlId, '/a')
    await db.update(pages).set({ outlinks: null }).where(eq(pages.id, a.id))

    expect(await jobs.expandPage(db, crawlId, a.id, 1)).toEqual({ queued: 1 })
    expect((await pageAt(crawlId, '/a')).status).toBe('pending')
    expect(await drain({ '/a': ['/x'] })).toEqual(['/a', '/x'])
  })

  it('resumes a stopped crawl where it left off', async () => {
    const crawlId = await newCrawl({ maxDepth: 2 })
    await finishRoot('r', [url('/a'), url('/b')])
    const a = (await jobs.claimNextPage(db, 'r'))!
    await jobs.completePage(db, 'r', a, result([url('/c')]))
    expect(await jobs.cancelCrawl(db, crawlId)).toBe(true)
    expect((await pageAt(crawlId, '/b')).status).toBe('cancelled')
    expect((await pageAt(crawlId, '/c')).status).toBe('cancelled')

    expect(await jobs.resumeCrawl(db, crawlId)).toBe(2)
    expect((await crawlRow(crawlId)).status).toBe('queued')
    expect(await jobs.resumeCrawl(db, crawlId)).toBe(0)
    // Only what Stop interrupted is captured, and the crawl carries on from there.
    expect(await drain({ '/b': ['/d'] })).toEqual(['/b', '/c', '/d'])
    expect((await crawlRow(crawlId)).status).toBe('done')
  })

  it('refetches a whole finished crawl level by level', async () => {
    const crawlId = await newCrawl({ maxDepth: 2 })
    await finishRoot('r', [url('/a'), url('/b')])
    await drain({ '/a': ['/x'] })
    await db.update(pages).set({ status: 'failed', error: 'boom' }).where(eq(pages.id, (await pageAt(crawlId, '/x')).id))
    expect((await crawlRow(crawlId)).status).toBe('done')

    expect(await jobs.refetchCrawl(db, crawlId)).toBe(4)
    expect(await crawlRow(crawlId)).toMatchObject({ status: 'queued', finishedAt: null })
    expect((await pageRows(crawlId)).every((p) => p.status === 'pending' && p.attempts === 0 && !p.error)).toBe(true)
    // Not again while it's running.
    expect(await jobs.refetchCrawl(db, crawlId)).toBe(0)

    // The root goes first; the site's links are rediscovered as it's recaptured.
    const captured = await drain({ '/': ['/a', '/b', '/c'], '/a': ['/x'] })
    expect(captured[0]).toBe('/')
    expect(captured.sort()).toEqual(['/', '/a', '/b', '/c', '/x'])
    expect((await pageAt(crawlId, '/x')).status).toBe('done')
    expect(await linkPairs(crawlId)).toEqual(['/>/a', '/>/b', '/>/c', '/a>/x'])
    expect((await crawlRow(crawlId)).status).toBe('done')
  })

  it('refetches a page and everything filed under it', async () => {
    const crawlId = await newCrawl({ maxDepth: 3 })
    await finishRoot('r', [url('/a'), url('/b')])
    await drain({ '/a': ['/a/1', '/b'], '/a/1': ['/a/1/x'], '/b': ['/b/1'] })
    const a = await pageAt(crawlId, '/a')

    // /b is linked from /a but filed under the root, so it isn't part of /a's branch.
    expect(await jobs.refetchBranch(db, crawlId, [a.id])).toBe(3)
    expect((await crawlRow(crawlId)).status).toBe('queued')
    expect(await jobs.refetchBranch(db, crawlId, [a.id])).toBe(0)

    expect(await drain({ '/a': ['/a/1', '/a/2'], '/a/1': ['/a/1/x'] })).toEqual(['/a', '/a/1', '/a/2', '/a/1/x'])
    expect((await pageAt(crawlId, '/a/2')).parentPageId).toBe(a.id)
    expect(await linkPairs(crawlId)).not.toContain('/a>/b')
    expect((await crawlRow(crawlId)).status).toBe('done')
  })

  it('resumes a crawl whose start page failed by retrying it', async () => {
    const crawlId = await newCrawl()
    const root = (await jobs.claimNextPage(db, 'r'))!
    await jobs.completePage(db, 'r', root, result([], 'net::ERR_CONNECTION_REFUSED'))
    expect((await crawlRow(crawlId)).status).toBe('failed')

    expect(await jobs.resumeCrawl(db, crawlId)).toBe(1)
    expect(await crawlRow(crawlId)).toMatchObject({ status: 'queued', error: null })
    expect(await drain({ '/': ['/a'] })).toEqual(['/', '/a'])
    expect((await crawlRow(crawlId)).status).toBe('done')
  })
})

describe('runner settings', () => {
  it('falls back to defaults when nothing valid is stored', async () => {
    await db.delete(settings)
    expect(await getRunnerSettings(db)).toEqual(DEFAULT_RUNNER_SETTINGS)

    await db
      .insert(settings)
      .values({ key: 'runner', value: { fetchDelayMs: -5 }, updatedAt: new Date() })
    expect(await getRunnerSettings(db)).toEqual(DEFAULT_RUNNER_SETTINGS)

    await configure({ fetchDelayMs: 2500, slotsPerRunner: 8 })
    expect(await getRunnerSettings(db)).toMatchObject({ fetchDelayMs: 2500, slotsPerRunner: 8 })
  })
})

describe('crawl names', () => {
  it('stores a name when one is given', async () => {
    const named = await jobs.createCrawl(db, {
      name: 'Marketing site',
      rootUrl: ROOT,
      maxDepth: 0,
      maxPages: 1,
      viewports: ['desktop'],
      respectRobots: false,
    })
    expect((await crawlRow(named)).name).toBe('Marketing site')
    expect((await crawlRow(await newCrawl())).name).toBeNull()
  })

  it('trims names and treats a blank one as none', async () => {
    expect(crawlNameSchema.parse('  Raycast  ')).toBe('Raycast')
    expect(crawlNameSchema.parse('   ')).toBeNull()
    expect(crawlNameSchema.parse(null)).toBeNull()
    expect(crawlNameSchema.safeParse('x'.repeat(121)).success).toBe(false)
  })
})

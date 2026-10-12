import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-inspector-jobs-'))
process.env.DATA_DIR = tmp
process.env.DATABASE_URL = path.join(tmp, 'test.db')

const { db, openDb } = await import('../db/client')
const { crawls, links, pages, settings } = await import('../db/schema')
const jobs = await import('./jobs')
const { getRunnerSettings, saveRunnerSettings } = await import('./settings')
const { DEFAULT_RUNNER_SETTINGS } = await import('#/lib/schemas')
const { LEASE_MS, MAX_ATTEMPTS } = jobs

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** Override some runner settings; tests run without a fetch delay unless they set one. */
const configure = (overrides: Partial<typeof DEFAULT_RUNNER_SETTINGS> = {}) =>
  saveRunnerSettings(db, { ...DEFAULT_RUNNER_SETTINGS, fetchDelayMs: 0, ...overrides })

beforeEach(() => {
  db.delete(crawls).run()
  configure()
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
function finishRoot(runnerId: string, children: string[]) {
  const job = jobs.claimNextPage(db, runnerId)!
  expect(job.page.depth).toBe(0)
  expect(jobs.completePage(db, runnerId, job, result(children))).toBe(true)
}

const crawlRow = (id: string) => db.select().from(crawls).where(eq(crawls.id, id)).get()!
const pageRows = (id: string) => db.select().from(pages).where(eq(pages.crawlId, id)).all()

describe('crawl job queue', () => {
  it('hands each page to exactly one of several competing processes', async () => {
    const crawlId = newCrawl({ maxDepth: 1, maxPages: 1000 })
    finishRoot('seed', Array.from({ length: 200 }, (_, i) => url(`/p${i}`)))

    // Each child process claims and completes pages until the queue is empty.
    const script = `
      import { openDb } from '#/server/db/client'
      import { claimNextPage, completePage } from '#/server/crawler/jobs'
      const db = openDb()
      const id = process.argv.at(-1)
      const claimed = []
      let job
      while ((job = claimNextPage(db, id))) {
        claimed.push(job.page.id)
        completePage(db, id, job, { httpStatus: 200, title: null, error: null, discoveredUrls: [], screenshots: [] })
      }
      console.log(JSON.stringify(claimed))`
    const tsx = path.resolve('node_modules/.bin/tsx')
    const outputs = await Promise.all(
      [0, 1, 2, 3].map((i) =>
        promisify(execFile)(tsx, ['--eval', script, '--', `proc-${i}`], { env: process.env }),
      ),
    )
    const claimed = outputs.flatMap(({ stdout }) => JSON.parse(stdout.trim().split('\n').at(-1)!))

    expect(claimed).toHaveLength(200)
    expect(new Set(claimed).size).toBe(200)
    expect(crawlRow(crawlId).status).toBe('done')
  })

  it('limits pages in flight per crawl', () => {
    newCrawl()
    finishRoot('r', Array.from({ length: 10 }, (_, i) => url(`/p${i}`)))
    const other = openDb()
    const claimed = []
    for (let i = 0; i < 10; i++) {
      const job = jobs.claimNextPage(i % 2 ? db : other, `r${i % 2}`)
      if (job) claimed.push(job)
    }
    expect(claimed).toHaveLength(DEFAULT_RUNNER_SETTINGS.maxInFlightPerCrawl)
  })

  it('takes the in-flight limit from settings', () => {
    configure({ maxInFlightPerCrawl: 2 })
    newCrawl()
    finishRoot('r', Array.from({ length: 10 }, (_, i) => url(`/p${i}`)))
    const claimed = Array.from({ length: 10 }, () => jobs.claimNextPage(db, 'r')).filter(Boolean)
    expect(claimed).toHaveLength(2)
    expect(claimed[0]!.settings.maxInFlightPerCrawl).toBe(2)
  })

  it('spaces out page loads of a crawl by the fetch delay', () => {
    configure({ fetchDelayMs: 2000 })
    const crawlId = newCrawl()
    const t = Date.now()
    const root = jobs.claimNextPage(db, 'r', t)!
    expect(jobs.completePage(db, 'r', root, result([url('/a'), url('/b')]))).toBe(true)

    // The root finished early, but its children wait out the delay...
    expect(jobs.claimNextPage(db, 'r', t + 1999)).toBeNull()
    // ...while another crawl isn't held up by it.
    const other = newCrawl()
    expect(jobs.claimNextPage(db, 'r', t + 1999)!.crawl.id).toBe(other)

    const a = jobs.claimNextPage(db, 'r', t + 2000)!
    expect(a.crawl.id).toBe(crawlId)
    expect(a.crawl.nextFetchAt).toEqual(new Date(t + 4000))
    // Spaced from the last claim even while that page is still loading.
    expect(jobs.claimNextPage(db, 'r', t + 3999)).toBeNull()
    expect(jobs.claimNextPage(db, 'r', t + 4000)!.page.url).toBe(url('/b'))
  })

  it.each([true, false])('uses a longer robots.txt Crawl-delay when honoring it is %s', (honor) => {
    configure({ fetchDelayMs: 1000, honorCrawlDelay: honor })
    const crawlId = newCrawl()
    const t = Date.now()
    const root = jobs.claimNextPage(db, 'r', t)!
    jobs.completePage(db, 'r', root, {
      ...result([url('/a'), url('/b')]),
      hostname: 'example.test',
      robotsTxt: 'User-agent: *\nCrawl-delay: 5',
    })
    expect(crawlRow(crawlId).crawlDelayMs).toBe(5000)

    expect(jobs.claimNextPage(db, 'r', t + 1000)).not.toBeNull()
    const next = jobs.claimNextPage(db, 'r', t + 2000)
    if (honor) {
      expect(next).toBeNull()
      expect(jobs.claimNextPage(db, 'r', t + 6000)).not.toBeNull()
    } else {
      expect(next).not.toBeNull()
    }
  })

  it('caps the Crawl-delay it will wait for', () => {
    const crawlId = newCrawl()
    const root = jobs.claimNextPage(db, 'r')!
    jobs.completePage(db, 'r', root, {
      ...result(),
      hostname: 'example.test',
      robotsTxt: 'User-agent: *\nCrawl-delay: 3600',
    })
    expect(crawlRow(crawlId).crawlDelayMs).toBe(jobs.MAX_CRAWL_DELAY_MS)
  })

  it('finishes a depth level before handing out the next', () => {
    const crawlId = newCrawl()
    finishRoot('r', [url('/a'), url('/b')])
    const a = jobs.claimNextPage(db, 'r')!
    const b = jobs.claimNextPage(db, 'r')!
    expect(jobs.completePage(db, 'r', a, result([url('/a/1'), url('/b')]))).toBe(true)

    // /b is still being captured, so /a/1 has to wait.
    expect(jobs.claimNextPage(db, 'r')).toBeNull()
    expect(jobs.completePage(db, 'r', b, result([url('/a/1')]))).toBe(true)
    const deep = jobs.claimNextPage(db, 'r')!
    expect(deep.page.url).toBe(url('/a/1'))
    expect(deep.page.depth).toBe(2)
    expect(deep.page.parentPageId).toBe(a.page.id)

    // Links point at pages whichever level they were found on; /a -> /b is a cross-link.
    const edges = db.select().from(links).where(eq(links.crawlId, crawlId)).all()
    expect(edges).toContainEqual(
      expect.objectContaining({ fromPageId: a.page.id, toPageId: b.page.id }),
    )
    expect(edges).toContainEqual(
      expect.objectContaining({ fromPageId: b.page.id, toPageId: deep.page.id }),
    )

    expect(jobs.completePage(db, 'r', deep, result([url('/a/1/x')]))).toBe(true)
    // maxDepth 2: /a/1's links aren't followed, and the crawl is finished.
    expect(pageRows(crawlId)).toHaveLength(4)
    expect(crawlRow(crawlId).status).toBe('done')
  })

  it('stops adding pages at maxPages', () => {
    const crawlId = newCrawl({ maxPages: 3 })
    finishRoot('r', [url('/a'), url('/b'), url('/c'), url('/d')])
    expect(pageRows(crawlId)).toHaveLength(3)
    expect(crawlRow(crawlId).pageCount).toBe(3)
  })

  it('requeues pages whose runner disappeared, then gives up on them', () => {
    const crawlId = newCrawl()
    let now = Date.now()
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const job = jobs.claimNextPage(db, `dead-${attempt}`, now)!
      expect(job.page.attempts).toBe(attempt)
      // A heartbeat keeps the claim alive...
      jobs.heartbeat(db, `dead-${attempt}`, [job.page.id], now + LEASE_MS / 2)
      expect(jobs.reapExpiredLeases(db, now + LEASE_MS + 1)).toBe(0)
      // ...but once it stops, the page is reaped.
      now += 2 * LEASE_MS
      expect(jobs.reapExpiredLeases(db, now)).toBe(1)
      // The lost runner can no longer report a result.
      expect(jobs.completePage(db, `dead-${attempt}`, job, result())).toBe(false)
    }
    const [root] = pageRows(crawlId)
    expect(root.status).toBe('failed')
    // The root page failing fails the crawl.
    expect(crawlRow(crawlId)).toMatchObject({ status: 'failed', error: 'Runner lost while capturing' })
  })

  it('drops results for cancelled crawls', () => {
    const crawlId = newCrawl()
    finishRoot('r', [url('/a'), url('/b')])
    const a = jobs.claimNextPage(db, 'r')!
    expect(jobs.isCrawlActive(db, crawlId)).toBe(true)

    expect(jobs.cancelCrawl(db, crawlId)).toBe(true)
    expect(jobs.isCrawlActive(db, crawlId)).toBe(false)
    expect(jobs.completePage(db, 'r', a, result([url('/c')]))).toBe(false)
    expect(jobs.claimNextPage(db, 'r')).toBeNull()
    expect(crawlRow(crawlId).status).toBe('cancelled')
    const open = pageRows(crawlId).filter((p) => p.depth > 0)
    expect(open.every((p) => p.status === 'failed' && p.error === 'Crawl cancelled')).toBe(true)
    expect(jobs.cancelCrawl(db, crawlId)).toBe(false)
  })

  it('serves the oldest crawl first', () => {
    const first = newCrawl()
    const second = newCrawl()
    expect(jobs.claimNextPage(db, 'r')!.crawl.id).toBe(first)
    // The first crawl is blocked on its root, so a free slot moves on to the next one.
    expect(jobs.claimNextPage(db, 'r')!.crawl.id).toBe(second)
  })
})

describe('runner settings', () => {
  it('falls back to defaults when nothing valid is stored', () => {
    db.delete(settings).run()
    expect(getRunnerSettings(db)).toEqual(DEFAULT_RUNNER_SETTINGS)

    db.insert(settings)
      .values({ key: 'runner', value: { fetchDelayMs: -5 }, updatedAt: new Date() })
      .run()
    expect(getRunnerSettings(db)).toEqual(DEFAULT_RUNNER_SETTINGS)

    configure({ fetchDelayMs: 2500, slotsPerRunner: 8 })
    expect(getRunnerSettings(db)).toMatchObject({ fetchDelayMs: 2500, slotsPerRunner: 8 })
  })
})

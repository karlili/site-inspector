import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_FRAME_HEIGHT, VIEWPORTS, previewPath } from '#/lib/viewports'

// Isolate the database and screenshots from the dev data directory.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-inspector-test-'))
process.env.DATA_DIR = tmp
process.env.DATABASE_URL = path.join(tmp, 'test.db')

const html = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body style="height:1600px"><h1>${title}</h1>${body}</body></html>`

// / -> /a, /b, external, pdf ; /a -> /a/deep ; /a/deep -> /a/deeper ; /b -> / , /missing
const site: Record<string, string> = {
  '/': html(
    'Home',
    `<a href="/a">A</a> <a href="b#frag">B</a> <a href="https://external.invalid/">Ext</a>
     <a href="/file.pdf">PDF</a> <a href="mailto:x@y.z">Mail</a> <a href="/private">Private</a>`,
  ),
  '/a': html('Page A', '<a href="/a/deep">Deep</a>'),
  '/a/deep': html('Deep', '<a href="/a/deeper">Deeper</a>'),
  '/a/deeper': html('Deeper', ''),
  '/b': html('Page B', '<a href="/">Home</a> <a href="/missing">Missing</a>'),
  '/private': html('Private', ''),
}

let server: http.Server
let baseUrl: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('User-agent: *\nDisallow: /private')
      return
    }
    const body = site[url.pathname]
    res
      .writeHead(body ? 200 : 404, { 'content-type': 'text/html' })
      .end(body ?? html('Not found', ''))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function crawlSite(maxDepth: number, viewports: ('mobile' | 'desktop')[]) {
  const { db, openDb } = await import('../db/client')
  const { createCrawl } = await import('./jobs')
  const { Runner } = await import('#/runner/runner')
  const { getCrawl } = await loadDetail()
  const id = createCrawl(db, {
    rootUrl: `${baseUrl}/`,
    maxDepth,
    maxPages: 50,
    viewports,
    respectRobots: true,
  })
  // Two single-slot runners, each with its own connection like separate processes:
  // while one captures a page the other must pick up its sibling.
  const runners = [0, 1].map(
    (i) => new Runner({ db: openDb(), id: `runner-${i}`, concurrency: 1, pollMs: 50 }),
  )
  await Promise.all(runners.map((r) => r.start()))
  try {
    await expect
      .poll(() => getCrawl(id).crawl.status, { timeout: 90_000, interval: 100 })
      .not.toMatch(/queued|running/)
  } finally {
    await Promise.all(runners.map((r) => r.stop()))
  }
  return getCrawl(id)
}

async function loadDetail() {
  const { db } = await import('../db/client')
  const { crawls, links, pages, screenshots } = await import('../db/schema')
  const { eq } = await import('drizzle-orm')
  return {
    getCrawl: (id: string) => ({
      crawl: db.select().from(crawls).where(eq(crawls.id, id)).get()!,
      pages: db.select().from(pages).where(eq(pages.crawlId, id)).all(),
      screenshots: db.select().from(screenshots).where(eq(screenshots.crawlId, id)).all(),
      links: db.select().from(links).where(eq(links.crawlId, id)).all(),
    }),
  }
}

describe('runCrawl', () => {
  it('crawls same-site pages up to the requested depth', async () => {
    const { crawl, pages, screenshots, links } = await crawlSite(1, ['mobile', 'desktop'])
    expect(crawl.status).toBe('done')

    const paths = pages.map((p) => new URL(p.url).pathname).sort()
    // Depth 1: root plus its direct same-site links; robots-blocked, external, pdf and mailto skipped.
    expect(paths).toEqual(['/', '/a', '/b'])
    expect(pages.every((p) => p.status === 'done')).toBe(true)
    expect(pages.find((p) => p.depth === 0)?.title).toBe('Home')

    const root = pages.find((p) => p.depth === 0)!
    expect(pages.filter((p) => p.depth === 1).every((p) => p.parentPageId === root.id)).toBe(true)

    // One full-page capture per page per viewport, written to disk.
    expect(screenshots).toHaveLength(pages.length * 2)
    for (const shot of screenshots) {
      expect(fs.existsSync(path.join(tmp, 'screenshots', shot.filePath))).toBe(true)
      expect(fs.existsSync(path.join(tmp, 'screenshots', shot.thumbPath))).toBe(true)
      expect(shot.height).toBeGreaterThanOrEqual(1600)
    }
    const mobile = screenshots.find((s) => s.viewport === 'mobile')!
    expect(mobile.width).toBe(375)

    // Board previews: the top of the page a full-height frame shows, in two sizes.
    const desktop = screenshots.find((s) => s.viewport === 'desktop')!
    const full = await sharp(path.join(tmp, 'screenshots', previewPath(desktop.filePath, 'full'))).metadata()
    const small = await sharp(path.join(tmp, 'screenshots', previewPath(desktop.filePath, 'small'))).metadata()
    expect(full.width).toBe(480)
    expect(small.width).toBe(144)
    const frameRatio = Math.min(desktop.height / desktop.width, MAX_FRAME_HEIGHT / VIEWPORTS.desktop.frameWidth)
    expect(full.height! / full.width!).toBeCloseTo(frameRatio, 1)

    // /b links back to the root: recorded as a cross-link.
    const b = pages.find((p) => p.url.endsWith('/b'))!
    expect(links).toContainEqual(expect.objectContaining({ fromPageId: b.id, toPageId: root.id }))

    // Pages were shared out between both runners.
    expect(new Set(pages.map((p) => p.claimedBy)).size).toBe(2)
  })

  it('follows deeper levels and records failures', async () => {
    const { crawl, pages } = await crawlSite(3, ['desktop'])
    expect(crawl.status).toBe('done')
    const byPath = new Map(pages.map((p) => [new URL(p.url).pathname, p]))
    expect([...byPath.keys()].sort()).toEqual(['/', '/a', '/a/deep', '/a/deeper', '/b', '/missing'])
    expect(byPath.get('/a/deeper')?.depth).toBe(3)
    expect(byPath.get('/missing')?.httpStatus).toBe(404)
  })
})

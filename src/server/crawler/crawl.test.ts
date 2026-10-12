import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MAX_FRAME_HEIGHT, VIEWPORTS, previewPath, type ViewportId } from '#/lib/viewports'

// Isolate the database and screenshots from the dev data directory.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'site-inspector-test-'))
process.env.DATA_DIR = tmp
process.env.DATABASE_URL = path.join(tmp, 'test.db')

const html = (title: string, body: string, viewport = 'width=device-width, initial-scale=1') =>
  `<!doctype html><html><head><meta name="viewport" content="${viewport}"><title>${title}</title></head><body style="height:1600px"><h1>${title}</h1>${body}</body></html>`

// Not linked from the site; fetched directly by the device emulation test.
// /sniff serves its responsive layout only to phone user agents, like Wikipedia does.
const devicePages: Record<string, (userAgent: string) => string> = {
  '/sniff': (ua) => (/Mobile/.test(ua) ? html('Sniff', '') : html('Sniff', '', 'width=1120')),
  '/fixed': () => html('Fixed', '', 'width=1120'),
}

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
    const body = site[url.pathname] ?? devicePages[url.pathname]?.(req.headers['user-agent'] ?? '')
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
  const { saveRunnerSettings } = await import('./settings')
  const { DEFAULT_RUNNER_SETTINGS } = await import('#/lib/schemas')
  const { Runner } = await import('#/runner/runner')
  const { getCrawl } = await loadDetail()
  saveRunnerSettings(db, { ...DEFAULT_RUNNER_SETTINGS, fetchDelayMs: 0 })
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

describe('runner slots', () => {
  it('follows the slots-per-runner setting while running', async () => {
    const { db, openDb } = await import('../db/client')
    const { listOnlineRunners } = await import('./jobs')
    const { saveRunnerSettings } = await import('./settings')
    const { DEFAULT_RUNNER_SETTINGS } = await import('#/lib/schemas')
    const { Runner } = await import('#/runner/runner')
    const slots = () => listOnlineRunners(db).find((r) => r.id === 'resizing')?.concurrency

    saveRunnerSettings(db, { ...DEFAULT_RUNNER_SETTINGS, slotsPerRunner: 2 })
    const runner = new Runner({ db: openDb(), id: 'resizing', pollMs: 50, heartbeatMs: 50 })
    await runner.start()
    try {
      expect(runner.concurrency).toBe(2)
      expect(slots()).toBe(2)
      saveRunnerSettings(db, { ...DEFAULT_RUNNER_SETTINGS, slotsPerRunner: 4 })
      await expect.poll(slots, { timeout: 5000, interval: 50 }).toBe(4)
      saveRunnerSettings(db, { ...DEFAULT_RUNNER_SETTINGS, slotsPerRunner: 1 })
      await expect.poll(slots, { timeout: 5000, interval: 50 }).toBe(1)
    } finally {
      await runner.stop()
    }
  })
})

describe('device emulation', () => {
  it('loads pages as a phone or tablet would and fits wide layouts to the screen', async () => {
    const { deviceOptions, launchBrowser } = await import('./crawl')
    const { captureScreenshot } = await import('./screenshot')
    const { browser, userAgent } = await launchBrowser()
    const capture = async (viewport: ViewportId, pathname: string) => {
      const context = await browser.newContext(deviceOptions(viewport, userAgent))
      try {
        const page = await context.newPage()
        await page.goto(`${baseUrl}${pathname}`)
        const seen = await page.evaluate(() => ({
          userAgent: navigator.userAgent,
          layoutWidth: window.innerWidth,
          pixelRatio: window.devicePixelRatio,
        }))
        const name = `${viewport}${pathname.replace('/', '-')}`
        const shot = await captureScreenshot(page, viewport, path.join(tmp, 'screenshots'), 'devices', name)
        const image = await sharp(path.join(tmp, 'screenshots', shot.filePath)).metadata()
        return { seen, shot, image }
      } finally {
        await context.close()
      }
    }

    try {
      // A phone gets the responsive layout, rendered at its pixel ratio but stored at CSS size.
      const phone = await capture('mobile', '/sniff')
      expect(phone.seen).toEqual({
        userAgent: expect.stringMatching(/Android.*Mobile Safari/),
        layoutWidth: 375,
        pixelRatio: 3,
      })
      const pageHeight = phone.shot.height
      expect(pageHeight).toBeGreaterThanOrEqual(1600)
      expect(phone.shot.width).toBe(375)
      expect(phone.image).toMatchObject({ width: 375, height: pageHeight })

      // A tablet isn't sniffed as mobile, so it gets the 1120px layout, zoomed out to fit.
      const tablet = await capture('tablet', '/sniff')
      expect(tablet.seen.userAgent).toMatch(/Android/)
      expect(tablet.seen.userAgent).not.toMatch(/Mobile/)
      expect(tablet.seen.layoutWidth).toBe(1120)
      expect(tablet.shot).toMatchObject({ width: 768, height: Math.round((pageHeight * 768) / 1120) })
      expect(tablet.image).toMatchObject({ width: 768, height: tablet.shot.height })

      // A fixed-width page on a phone shows whole, not its left-hand third.
      const fixed = await capture('mobile', '/fixed')
      expect(fixed.seen.layoutWidth).toBe(1120)
      // Never shorter than one screen.
      expect(fixed.shot).toMatchObject({ width: 375, height: 812 })

      const desktop = await capture('desktop', '/sniff')
      expect(desktop.seen.userAgent).not.toMatch(/Android|Mobile/)
      expect(desktop.shot.width).toBe(1440)
    } finally {
      await browser.close()
    }
  })
})

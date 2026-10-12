import { randomUUID } from 'node:crypto'
import {
  chromium,
  type Browser,
  type BrowserContextOptions,
  type Page,
  type Response,
} from 'playwright'
import { VIEWPORTS, type ViewportId } from '#/lib/viewports'
import type { Crawl, Page as PageRow } from '../db/schema'
import { SCREENSHOT_DIR } from '../paths'
import type { PageResult } from './jobs'
import { fetchRobotsText, parseRobots, type RobotsRules } from './robots'
import { captureScreenshot } from './screenshot'
import { fetchSitemapUrls } from './sitemap'
import { isSameSite, looksLikeHtml, normalizeUrl } from './url'

const USER_AGENT_SUFFIX = 'SiteInspector/1.0'

export class CrawlCancelled extends Error {}

/** Launch Chromium along with the user agent every capture announces itself as. */
export async function launchBrowser(): Promise<{ browser: Browser; userAgent: string }> {
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const ua = await page.evaluate(() => navigator.userAgent)
  await page.close()
  return { browser, userAgent: `${ua.replace('HeadlessChrome', 'Chrome')} ${USER_AGENT_SUFFIX}` }
}

export interface CaptureOptions {
  browser: Browser
  userAgent: string
  crawl: Crawl
  page: PageRow
  /** Rules from the crawl's robots.txt; the root page fetches its own. */
  robots?: RobotsRules
  screenshotDir?: string
  /**
   * Part of every file name this capture writes (`<page id>-<capture id>-<viewport>`),
   * so recapturing a page never overwrites the files its current screenshots point at.
   */
  captureId?: string
  /** How long each page load may take. */
  navTimeoutMs?: number
  /** Checked between viewports; returning true throws CrawlCancelled. */
  isCancelled?: () => boolean
}

/**
 * Load one page at each of the crawl's viewports, capturing it full-page and
 * collecting the same-site links it points to. Failures are reported in the
 * result rather than thrown, so whatever was captured before them is kept.
 */
export async function capturePage({
  browser,
  userAgent,
  crawl,
  page: item,
  robots,
  screenshotDir = SCREENSHOT_DIR,
  captureId = randomUUID().slice(0, 8),
  navTimeoutMs = 30_000,
  isCancelled = () => false,
}: CaptureOptions): Promise<PageResult> {
  const result: PageResult = {
    httpStatus: null,
    title: null,
    error: null,
    discoveredUrls: [],
    screenshots: [],
  }
  let hostname = crawl.hostname

  // Link discovery happens in the widest viewport; mobile menus are often collapsed.
  const primaryViewport =
    (['desktop', 'tablet', 'mobile'] as const).find((v) => crawl.viewports.includes(v)) ??
    crawl.viewports[0]

  try {
    for (const viewport of crawl.viewports) {
      if (isCancelled()) throw new CrawlCancelled()
      const context = await browser.newContext({
        ...deviceOptions(viewport, userAgent),
        ignoreHTTPSErrors: true,
      })
      try {
        const page = await context.newPage()
        const response = await gotoSettled(page, item.url, navTimeoutMs)

        if (viewport === primaryViewport) {
          result.httpStatus = response?.status() ?? null
          const contentType = response?.headers()['content-type'] ?? ''
          if (contentType && !contentType.includes('html')) {
            throw new Error(`Not an HTML page (${contentType.split(';')[0]})`)
          }
          const finalUrl = normalizeUrl(page.url())
          if (!finalUrl || !isSameSite(finalUrl, hostname)) {
            throw new Error(`Redirected off-site to ${page.url()}`)
          }
          result.title = (await page.title()) || null

          // The root may redirect (e.g. to www.); follow the site it lands on.
          // Its robots.txt is read even when the crawl ignores the rules: it
          // says where the sitemaps are.
          let sitemapUrls: string[] = []
          if (item.depth === 0) {
            const { hostname: host, origin } = new URL(finalUrl)
            hostname = host
            result.hostname = hostname
            const robotsTxt = await fetchRobotsText(origin)
            result.robotsTxt = crawl.respectRobots ? robotsTxt : null
            robots = result.robotsTxt ? parseRobots(result.robotsTxt) : undefined
            sitemapUrls = await fetchSitemapUrls(origin, robotsTxt)
          }

          // Same-site pages the crawl may visit, normalized and de-duplicated.
          const crawlable = (raw: string[]) => {
            const urls = new Set<string>()
            for (const href of raw) {
              const url = normalizeUrl(href)
              if (!url || !isSameSite(url, hostname) || !looksLikeHtml(url)) continue
              if (robots && !robots.isAllowed(url)) continue
              urls.add(url)
            }
            return [...urls]
          }
          const hrefs = await page.$$eval('a[href], area[href]', (els) =>
            els.map((el) => (el as HTMLAnchorElement).href),
          )
          result.discoveredUrls = crawlable(hrefs)
          if (item.depth === 0) result.sitemapUrls = crawlable(sitemapUrls)
        }

        const shot = await captureScreenshot(page, viewport, screenshotDir, crawl.id, `${item.id}-${captureId}`)
        result.screenshots.push({ viewport, ...shot })
      } finally {
        await context.close().catch(() => {})
      }
    }
  } catch (err) {
    if (err instanceof CrawlCancelled) throw err
    result.error = errorMessage(err)
  }
  return result
}

/**
 * Emulate the device each viewport stands for: desktop Chrome, or Chrome for
 * Android on a phone or tablet. The user agent matters as much as the size:
 * many sites (Wikipedia among them) pick their mobile layout by user agent and
 * otherwise serve desktop HTML with a fixed-width viewport meta tag.
 */
export function deviceOptions(viewport: ViewportId, desktopUserAgent: string): BrowserContextOptions {
  const { width, height, deviceScaleFactor } = VIEWPORTS[viewport]
  const touch = viewport !== 'desktop'
  return {
    viewport: { width, height },
    screen: { width, height },
    deviceScaleFactor,
    // Phones and tablets both honour <meta name="viewport">.
    isMobile: touch,
    hasTouch: touch,
    userAgent: touch ? androidUserAgent(desktopUserAgent, viewport === 'mobile') : desktopUserAgent,
  }
}

/** Same Chrome version, Android platform; tablets drop the "Mobile" token, as Chrome does. */
function androidUserAgent(desktopUserAgent: string, phone: boolean) {
  const ua = desktopUserAgent.replace(/\([^)]*\)/, '(Linux; Android 10; K)')
  return phone ? ua.replace(' Safari/', ' Mobile Safari/') : ua
}

async function gotoSettled(page: Page, url: string, timeout: number): Promise<Response | null> {
  try {
    return await page.goto(url, { waitUntil: 'networkidle', timeout })
  } catch (err) {
    // Sites with long-polling/analytics never go idle; fall back to the load event.
    if (!/Timeout/i.test(errorMessage(err))) throw err
    return page.goto(url, { waitUntil: 'load', timeout })
  }
}

export function errorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.split('\n')[0].slice(0, 500)
}

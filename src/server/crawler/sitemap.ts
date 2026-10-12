import { gunzipSync } from 'node:zlib'

/** Most sitemap URLs kept per crawl; large sites list far more pages than a crawl captures. */
export const MAX_SITEMAP_URLS = 5000
/** Child sitemaps read from a sitemap index. */
const MAX_CHILD_SITEMAPS = 20
const FETCH_TIMEOUT = 10_000

/** `Sitemap:` lines in robots.txt; unlike rules they apply to every user agent. */
export function sitemapsFromRobots(robotsTxt: string | null): string[] {
  if (!robotsTxt) return []
  return robotsTxt.split(/\r?\n/).flatMap((line) => {
    const match = /^\s*sitemap\s*:\s*(\S+)/i.exec(line)
    return match && /^https?:\/\//i.test(match[1]) ? [match[1]] : []
  })
}

/**
 * Every page URL the site's sitemaps list, as written in them (callers
 * normalize and filter). Reads the sitemaps robots.txt declares, or
 * /sitemap.xml, following a sitemap index one level down. Anything missing or
 * unreadable is skipped, so a site without a sitemap gives an empty list.
 */
export async function fetchSitemapUrls(origin: string, robotsTxt: string | null): Promise<string[]> {
  const declared = sitemapsFromRobots(robotsTxt)
  const queue = (declared.length ? declared : [new URL('/sitemap.xml', origin).href]).map((url) => ({
    url,
    child: false,
  }))
  const seen = new Set(queue.map((s) => s.url))
  const urls = new Set<string>()
  let children = 0

  for (let i = 0; i < queue.length && urls.size < MAX_SITEMAP_URLS; i++) {
    const xml = await fetchXml(queue[i].url)
    if (!xml) continue
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*(.*?)\s*(?:\]\]>)?\s*<\/loc>/gis)].map((m) =>
      decodeEntities(m[1]),
    )
    if (/<sitemapindex[\s>]/i.test(xml)) {
      if (queue[i].child) continue
      for (const url of locs) {
        if (children >= MAX_CHILD_SITEMAPS) break
        if (seen.has(url) || !/^https?:\/\//i.test(url)) continue
        seen.add(url)
        queue.push({ url, child: true })
        children++
      }
    } else {
      for (const url of locs) {
        if (urls.size >= MAX_SITEMAP_URLS) break
        urls.add(url)
      }
    }
  }
  return [...urls]
}

/** A sitemap's XML, gunzipped if it's a .gz file; null for anything that isn't a sitemap. */
async function fetchXml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
    if (!res.ok) return null
    let body = Buffer.from(await res.arrayBuffer())
    if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body)
    const xml = body.toString('utf8')
    // Many sites answer every path with an HTML page, even a 200 one.
    return /<(urlset|sitemapindex)[\s>]/i.test(xml) ? xml : null
  } catch {
    return null
  }
}

function decodeEntities(text: string) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

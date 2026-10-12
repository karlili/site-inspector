const NON_HTML_EXT =
  /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|avi|mp3|wav|ogg|zip|gz|tgz|rar|7z|tar|exe|dmg|pkg|msi|apk|docx?|xlsx?|pptx?|csv|json|xml|rss|txt|css|js|mjs|map|woff2?|ttf|otf|eot)$/i

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|msclkid|mc_cid|mc_eid|ref|_ga)$/i

/** `www.example.com` and `example.com` are considered the same site. */
export function siteHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '')
}

/**
 * Canonical form used for de-duplication. Returns null for anything that is
 * not a crawlable http(s) page URL.
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim(), base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null

  url.hash = ''
  url.username = ''
  url.password = ''
  url.hostname = url.hostname.toLowerCase()
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = ''
  }

  const params = [...url.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
  url.search = new URLSearchParams(params).toString()

  // Collapse duplicate slashes, strip trailing slash (except the root) and index files.
  let pathname = url.pathname.replace(/\/{2,}/g, '/')
  pathname = pathname.replace(/\/index\.(html?|php|aspx?)$/i, '/')
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1)
  url.pathname = pathname

  return url.toString()
}

export function isSameSite(url: string, rootHostname: string): boolean {
  try {
    return siteHost(new URL(url).hostname) === siteHost(rootHostname)
  } catch {
    return false
  }
}

export function looksLikeHtml(url: string): boolean {
  try {
    return !NON_HTML_EXT.test(new URL(url).pathname)
  } catch {
    return false
  }
}

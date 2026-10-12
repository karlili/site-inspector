import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fetchSitemapUrls, sitemapsFromRobots } from './sitemap'

const urlset = (...locs: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((loc) => `<url><loc>${loc}</loc></url>`)
    .join('')}</urlset>`

let server: http.Server
let origin: string
let files: Record<string, string | Buffer> = {}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = files[req.url ?? '/']
    if (body === undefined) res.writeHead(404).end('<html>Not found</html>')
    else res.writeHead(200).end(body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
})

describe('sitemapsFromRobots', () => {
  it('reads Sitemap lines whatever their case or group', () => {
    const robots = 'User-agent: *\nDisallow: /x\nsitemap: https://a.test/one.xml\n\nUser-agent: bot\nSitemap:https://a.test/two.xml\nSitemap: /relative.xml'
    expect(sitemapsFromRobots(robots)).toEqual(['https://a.test/one.xml', 'https://a.test/two.xml'])
    expect(sitemapsFromRobots(null)).toEqual([])
  })
})

describe('fetchSitemapUrls', () => {
  it('falls back to /sitemap.xml and decodes entities and CDATA', async () => {
    files = {
      '/sitemap.xml': urlset(`${origin}/a?x=1&amp;y=2`, `<![CDATA[${origin}/b]]>`, `  ${origin}/c  `),
    }
    expect(await fetchSitemapUrls(origin, null)).toEqual([`${origin}/a?x=1&y=2`, `${origin}/b`, `${origin}/c`])
  })

  it('follows the sitemaps robots.txt declares, through an index, gzipped or not', async () => {
    files = {
      '/index.xml': `<sitemapindex><sitemap><loc>${origin}/pages.xml.gz</loc></sitemap><sitemap><loc>${origin}/posts.xml</loc></sitemap></sitemapindex>`,
      '/pages.xml.gz': gzipSync(urlset(`${origin}/a`, `${origin}/b`)),
      '/posts.xml': urlset(`${origin}/b`, `${origin}/post`),
      // Only read when robots.txt doesn't name any sitemaps.
      '/sitemap.xml': urlset(`${origin}/ignored`),
    }
    const urls = await fetchSitemapUrls(origin, `Sitemap: ${origin}/index.xml`)
    expect(urls).toEqual([`${origin}/a`, `${origin}/b`, `${origin}/post`])
  })

  it('gives nothing for a missing sitemap or an HTML page in its place', async () => {
    files = {}
    expect(await fetchSitemapUrls(origin, null)).toEqual([])
    files = { '/sitemap.xml': '<!doctype html><html><body>Home</body></html>' }
    expect(await fetchSitemapUrls(origin, null)).toEqual([])
  })
})

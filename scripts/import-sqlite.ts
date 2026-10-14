/**
 * `pnpm db:import-sqlite [file]`: copy crawls from the SQLite database earlier
 * versions used (default `data/site-inspector.db`) into Postgres (DATABASE_URL).
 * Crawls already in Postgres are skipped, so it's safe to run again.
 *
 * Screenshots stay where they are when they're stored on local disk. With
 * SCREENSHOT_STORAGE=s3, the files under the local screenshot directory
 * (`--screenshots <dir>`, default `data/screenshots`) are uploaded to the
 * bucket as well.
 */
import path from 'node:path'
import { parseArgs } from 'node:util'
import { DatabaseSync } from 'node:sqlite'
import { closeDb, db } from '#/server/db/client'
import { crawls, links, pages, screenshots, settings } from '#/server/db/schema'
import { DATA_DIR } from '#/server/paths'
import { LocalStore, screenshotStore } from '#/server/storage'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { screenshots: { type: 'string' } },
})
const file = path.resolve(positionals[0] ?? path.join(DATA_DIR, 'site-inspector.db'))
const sqlite = new DatabaseSync(file, { readOnly: true })

type Row = Record<string, any>
const rows = (table: string) => sqlite.prepare(`select * from ${table} order by rowid`).all() as Row[]
/** SQLite stored created/finished times in seconds, everything else in milliseconds. */
const seconds = (v: number | null) => (v == null ? null : new Date(v * 1000))
const millis = (v: number | null) => (v == null ? null : new Date(v))
const json = (v: string | null) => (v == null ? null : JSON.parse(v))

async function insertAll<T>(values: T[], insert: (batch: T[]) => Promise<unknown>) {
  for (let i = 0; i < values.length; i += 500) await insert(values.slice(i, i + 500))
}

const counts = await db.transaction(async (tx) => {
  const existing = new Set((await tx.select({ id: crawls.id }).from(crawls)).map((c) => c.id))
  const allCrawls = rows('crawls')
  const crawlRows = allCrawls.filter((c) => !existing.has(c.id))
  const imported = new Set(crawlRows.map((c) => c.id))
  const ofImported = (r: Row) => imported.has(r.crawl_id)

  await insertAll(crawlRows, (batch) =>
    tx.insert(crawls).values(
      batch.map((c) => ({
        id: c.id,
        name: c.name,
        rootUrl: c.root_url,
        hostname: c.hostname,
        maxDepth: c.max_depth,
        maxPages: c.max_pages,
        viewports: json(c.viewports),
        respectRobots: !!c.respect_robots,
        status: c.status,
        error: c.error,
        pageCount: c.page_count,
        robotsTxt: c.robots_txt,
        crawlDelayMs: c.crawl_delay_ms,
        sitemapUrls: json(c.sitemap_urls),
        nextFetchAt: millis(c.next_fetch_at),
        createdAt: seconds(c.created_at)!,
        finishedAt: seconds(c.finished_at),
      })),
    ),
  )
  const pageRows = rows('pages').filter(ofImported)
  await insertAll(pageRows, (batch) =>
    tx.insert(pages).values(
      batch.map((p) => ({
        id: p.id,
        crawlId: p.crawl_id,
        url: p.url,
        title: p.title,
        depth: p.depth,
        parentPageId: p.parent_page_id,
        httpStatus: p.http_status,
        status: p.status,
        error: p.error,
        redirectUrl: p.redirect_url,
        posX: p.pos_x,
        posY: p.pos_y,
        claimedBy: p.claimed_by,
        leaseExpiresAt: millis(p.lease_expires_at),
        attempts: p.attempts,
        outlinks: json(p.outlinks),
        expandToDepth: p.expand_to_depth,
        source: p.source,
      })),
    ),
  )
  const linkRows = rows('links').filter(ofImported)
  await insertAll(linkRows, (batch) =>
    tx
      .insert(links)
      .values(batch.map((l) => ({ crawlId: l.crawl_id, fromPageId: l.from_page_id, toPageId: l.to_page_id })))
      .onConflictDoNothing(),
  )
  const shotRows = rows('screenshots').filter(ofImported)
  await insertAll(shotRows, (batch) =>
    tx.insert(screenshots).values(
      batch.map((s) => ({
        id: s.id,
        crawlId: s.crawl_id,
        pageId: s.page_id,
        viewport: s.viewport,
        width: s.width,
        height: s.height,
        filePath: s.file_path,
        thumbPath: s.thumb_path,
      })),
    ),
  )
  for (const s of rows('settings')) {
    await tx
      .insert(settings)
      .values({ key: s.key, value: json(s.value), updatedAt: millis(s.updated_at)! })
      .onConflictDoNothing()
  }
  return { crawls: crawlRows.length, skipped: allCrawls.length - crawlRows.length, pages: pageRows.length, screenshots: shotRows.length }
})
console.log(
  `Imported ${counts.crawls} crawls (${counts.pages} pages, ${counts.screenshots} screenshots) from ${file}` +
    (counts.skipped ? `; skipped ${counts.skipped} already there` : ''),
)

const store = screenshotStore()
if (!(store instanceof LocalStore)) {
  const local = new LocalStore(path.resolve(values.screenshots ?? path.join(DATA_DIR, 'screenshots')))
  const keys = await local.list('')
  const types: Record<string, string> = { '.jpg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png' }
  let uploaded = 0
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let key; (key = keys.pop()) !== undefined; ) {
        const body = await local.get(key)
        if (!body) continue
        await store.put(key, body, types[path.extname(key)] ?? 'application/octet-stream')
        if (++uploaded % 200 === 0) console.log(`Uploaded ${uploaded} screenshot files…`)
      }
    }),
  )
  console.log(`Uploaded ${uploaded} screenshot files from ${local.root}`)
}

sqlite.close()
await closeDb(db)

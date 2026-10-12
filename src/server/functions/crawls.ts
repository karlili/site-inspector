import fs from 'node:fs/promises'
import path from 'node:path'
import { createServerFn } from '@tanstack/react-start'
import { asc, desc, eq, sql } from 'drizzle-orm'
import { crawlIdSchema, crawlInputSchema, nodePositionsSchema } from '#/lib/schemas'
import { db } from '../db/client'
import { crawls, links, pages, screenshots } from '../db/schema'
import { cancelCrawl as cancelCrawlJobs, createCrawl, listOnlineRunners } from '../crawler/jobs'
import { normalizeUrl } from '../crawler/url'
import { SCREENSHOT_DIR } from '../paths'

export const startCrawl = createServerFn({ method: 'POST' })
  .validator(crawlInputSchema)
  .handler(async ({ data }) => {
    const rootUrl = normalizeUrl(data.url)
    if (!rootUrl) throw new Error('Invalid URL')
    // Runners pick the root page up from the database; nothing runs in this process.
    const id = createCrawl(db, {
      rootUrl,
      maxDepth: data.maxDepth,
      maxPages: data.maxPages,
      viewports: data.viewports,
      respectRobots: data.respectRobots,
    })
    return { id }
  })

export const listCrawls = createServerFn({ method: 'GET' }).handler(async () => {
  return db.select().from(crawls).orderBy(desc(crawls.createdAt), desc(sql`rowid`)).all()
})

export const getCrawl = createServerFn({ method: 'GET' })
  .validator(crawlIdSchema)
  .handler(async ({ data }) => {
    const crawl = db.select().from(crawls).where(eq(crawls.id, data.crawlId)).get()
    if (!crawl) throw new Error('Crawl not found')
    return {
      crawl,
      pages: db
        .select()
        .from(pages)
        .where(eq(pages.crawlId, data.crawlId))
        .orderBy(asc(pages.depth), asc(sql`rowid`))
        .all(),
      screenshots: db
        .select()
        .from(screenshots)
        .where(eq(screenshots.crawlId, data.crawlId))
        .all(),
      links: db.select().from(links).where(eq(links.crawlId, data.crawlId)).all(),
    }
  })

export const saveNodePositions = createServerFn({ method: 'POST' })
  .validator(nodePositionsSchema)
  .handler(async ({ data }) => {
    db.transaction((tx) => {
      for (const { pageId, x, y } of data.positions) {
        tx.update(pages)
          .set({ posX: x, posY: y })
          .where(sql`${pages.id} = ${pageId} and ${pages.crawlId} = ${data.crawlId}`)
          .run()
      }
    })
    return { ok: true }
  })

export const resetNodePositions = createServerFn({ method: 'POST' })
  .validator(crawlIdSchema)
  .handler(async ({ data }) => {
    db.update(pages).set({ posX: null, posY: null }).where(eq(pages.crawlId, data.crawlId)).run()
    return { ok: true }
  })

export const cancelCrawl = createServerFn({ method: 'POST' })
  .validator(crawlIdSchema)
  .handler(async ({ data }) => {
    return { cancelled: cancelCrawlJobs(db, data.crawlId) }
  })

export const deleteCrawl = createServerFn({ method: 'POST' })
  .validator(crawlIdSchema)
  .handler(async ({ data }) => {
    cancelCrawlJobs(db, data.crawlId)
    db.delete(crawls).where(eq(crawls.id, data.crawlId)).run()
    await fs.rm(path.join(SCREENSHOT_DIR, data.crawlId), { recursive: true, force: true })
    return { ok: true }
  })

export const listRunners = createServerFn({ method: 'GET' }).handler(async () => {
  return listOnlineRunners(db).map(({ id, hostname, concurrency, activeJobs }) => ({
    id,
    hostname,
    concurrency,
    activeJobs,
  }))
})

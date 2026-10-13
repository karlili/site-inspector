import fs from 'node:fs/promises'
import path from 'node:path'
import { createServerFn } from '@tanstack/react-start'
import { asc, desc, eq, sql } from 'drizzle-orm'
import {
  crawlIdSchema,
  crawlInputSchema,
  expandPageSchema,
  pageBranchSchema,
  pageRefSchema,
  renameCrawlSchema,
} from '#/lib/schemas'
import { db } from '../db/client'
import { crawls, links, pages, screenshots } from '../db/schema'
import {
  cancelCrawl as cancelCrawlJobs,
  createCrawl,
  expandPage as expandPageJobs,
  listOnlineRunners,
  refetchBranch as refetchBranchJobs,
  refetchCrawl as refetchCrawlJobs,
  refetchPage as refetchPageJobs,
  resumeCrawl as resumeCrawlJobs,
} from '../crawler/jobs'
import { normalizeUrl } from '../crawler/url'
import { SCREENSHOT_DIR } from '../paths'

export const startCrawl = createServerFn({ method: 'POST' })
  .validator(crawlInputSchema)
  .handler(async ({ data }) => {
    const rootUrl = normalizeUrl(data.url)
    if (!rootUrl) throw new Error('Invalid URL')
    // Runners pick the root page up from the database; nothing runs in this process.
    const id = createCrawl(db, {
      name: data.name,
      rootUrl,
      maxDepth: data.maxDepth,
      maxPages: data.maxPages,
      viewports: data.viewports,
      respectRobots: data.respectRobots,
    })
    return { id }
  })

export const renameCrawl = createServerFn({ method: 'POST' })
  .validator(renameCrawlSchema)
  .handler(async ({ data }) => {
    const renamed = db
      .update(crawls)
      .set({ name: data.name })
      .where(eq(crawls.id, data.crawlId))
      .returning({ name: crawls.name })
      .get()
    if (!renamed) throw new Error('Crawl not found')
    return renamed
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

export const cancelCrawl = createServerFn({ method: 'POST' })
  .validator(crawlIdSchema)
  .handler(async ({ data }) => {
    return { cancelled: cancelCrawlJobs(db, data.crawlId) }
  })

export const resumeCrawl = createServerFn({ method: 'POST' })
  .validator(crawlIdSchema)
  .handler(async ({ data }) => {
    return { queued: resumeCrawlJobs(db, data.crawlId) }
  })

export const refetchCrawl = createServerFn({ method: 'POST' })
  .validator(crawlIdSchema)
  .handler(async ({ data }) => {
    return { queued: refetchCrawlJobs(db, data.crawlId) }
  })

export const refetchPage = createServerFn({ method: 'POST' })
  .validator(pageRefSchema)
  .handler(async ({ data }) => {
    return { queued: refetchPageJobs(db, data.crawlId, data.pageId) }
  })

export const refetchBranch = createServerFn({ method: 'POST' })
  .validator(pageBranchSchema)
  .handler(async ({ data }) => {
    return { queued: refetchBranchJobs(db, data.crawlId, data.pageIds) }
  })

export const expandPage = createServerFn({ method: 'POST' })
  .validator(expandPageSchema)
  .handler(async ({ data }) => {
    const result = expandPageJobs(db, data.crawlId, data.pageId, data.levels)
    if (!result) throw new Error('Page not found')
    return result
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

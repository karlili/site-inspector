import { createServerFn } from '@tanstack/react-start'
import { asc, desc, eq } from 'drizzle-orm'
import {
  crawlIdSchema,
  crawlInputSchema,
  expandPageSchema,
  isActive,
  pageBranchSchema,
  pageRefSchema,
  queueSchema,
  renameCrawlSchema,
} from '#/lib/schemas'
import { db } from '../db/client'
import { crawls, links, pages, screenshots } from '../db/schema'
import {
  cancelCrawl as cancelCrawlJobs,
  countCrawlPages,
  createCrawl,
  deleteCrawl as deleteCrawlJobs,
  expandPage as expandPageJobs,
  listOnlineRunners,
  listQueue,
  refetchBranch as refetchBranchJobs,
  refetchCrawl as refetchCrawlJobs,
  refetchPage as refetchPageJobs,
  resumeCrawl as resumeCrawlJobs,
} from '../crawler/jobs'
import { normalizeUrl } from '../crawler/url'
import { screenshotStore } from '../storage'

export const startCrawl = createServerFn({ method: 'POST' })
  .validator(crawlInputSchema)
  .handler(async ({ data }) => {
    const rootUrl = normalizeUrl(data.url)
    if (!rootUrl) throw new Error('Invalid URL')
    // Runners pick the root page up from the database; nothing runs in this process.
    const id = await createCrawl(db, {
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
    const [renamed] = await db
      .update(crawls)
      .set({ name: data.name })
      .where(eq(crawls.id, data.crawlId))
      .returning({ name: crawls.name })
    if (!renamed) throw new Error('Crawl not found')
    return renamed
  })

export const listCrawls = createServerFn({ method: 'GET' }).handler(async () => {
  const rows = await db.select().from(crawls).orderBy(desc(crawls.createdAt), desc(crawls.seq))
  // Progress only matters while runners are still working through a crawl.
  const counts = await countCrawlPages(
    db,
    rows.filter((c) => isActive(c.status)).map((c) => c.id),
  )
  return rows.map((crawl) => ({ ...crawl, progress: counts.get(crawl.id) ?? null }))
})

export const getCrawl = createServerFn({ method: 'GET' })
  .validator(crawlIdSchema)
  .handler(async ({ data }) => {
    const [crawl] = await db.select().from(crawls).where(eq(crawls.id, data.crawlId))
    if (!crawl) throw new Error('Crawl not found')
    const [pageRows, screenshotRows, linkRows] = await Promise.all([
      db
        .select()
        .from(pages)
        .where(eq(pages.crawlId, data.crawlId))
        .orderBy(asc(pages.depth), asc(pages.seq)),
      db.select().from(screenshots).where(eq(screenshots.crawlId, data.crawlId)),
      db.select().from(links).where(eq(links.crawlId, data.crawlId)),
    ])
    return { crawl, pages: pageRows, screenshots: screenshotRows, links: linkRows }
  })

export const cancelCrawl = createServerFn({ method: 'POST' })
  .validator(crawlIdSchema)
  .handler(async ({ data }) => {
    return { cancelled: await cancelCrawlJobs(db, data.crawlId) }
  })

export const resumeCrawl = createServerFn({ method: 'POST' })
  .validator(crawlIdSchema)
  .handler(async ({ data }) => {
    return { queued: await resumeCrawlJobs(db, data.crawlId) }
  })

export const refetchCrawl = createServerFn({ method: 'POST' })
  .validator(crawlIdSchema)
  .handler(async ({ data }) => {
    return { queued: await refetchCrawlJobs(db, data.crawlId) }
  })

export const refetchPage = createServerFn({ method: 'POST' })
  .validator(pageRefSchema)
  .handler(async ({ data }) => {
    return { queued: await refetchPageJobs(db, data.crawlId, data.pageId) }
  })

export const refetchBranch = createServerFn({ method: 'POST' })
  .validator(pageBranchSchema)
  .handler(async ({ data }) => {
    return { queued: await refetchBranchJobs(db, data.crawlId, data.pageIds) }
  })

export const expandPage = createServerFn({ method: 'POST' })
  .validator(expandPageSchema)
  .handler(async ({ data }) => {
    const result = await expandPageJobs(db, data.crawlId, data.pageId, data.levels)
    if (!result) throw new Error('Page not found')
    return result
  })

export const deleteCrawl = createServerFn({ method: 'POST' })
  .validator(crawlIdSchema)
  .handler(async ({ data }) => {
    await deleteCrawlJobs(db, data.crawlId)
    // Leftover files only cost space; the crawl is gone either way.
    await screenshotStore()
      .deletePrefix(`${data.crawlId}/`)
      .catch((err) => console.error(`Couldn't delete the screenshots of crawl ${data.crawlId}:`, err))
    return { ok: true }
  })

export const getQueue = createServerFn({ method: 'GET' })
  .validator(queueSchema)
  .handler(async ({ data }) => listQueue(db, { crawlId: data.crawlId }))

export const listRunners = createServerFn({ method: 'GET' }).handler(async () => {
  return (await listOnlineRunners(db)).map(({ id, hostname, concurrency, activeJobs }) => ({
    id,
    hostname,
    concurrency,
    activeJobs,
  }))
})

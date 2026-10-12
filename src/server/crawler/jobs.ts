import { randomUUID } from 'node:crypto'
import { and, count, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import type { CrawlInput } from '#/lib/schemas'
import type { ViewportId } from '#/lib/viewports'
import type { Db } from '../db/client'
import { crawls, links, pages, runners, screenshots, type Crawl, type Page } from '../db/schema'
import type { CapturedScreenshot } from './screenshot'

/**
 * The crawl queue lives in SQLite: every `pages` row is a job. Runners (any
 * number of processes sharing the database file) claim one page at a time and
 * write back what it linked to. Writes use IMMEDIATE transactions so SQLite
 * serializes them across processes and a page is never claimed twice.
 */

/** How long a claim stays valid without a heartbeat. */
export const LEASE_MS = 60_000
/** Claims that expire this many times are given up on. */
export const MAX_ATTEMPTS = 3
/** Pages of one crawl being captured at once, across all runners. */
export const MAX_IN_FLIGHT_PER_CRAWL = 6
/** Runners not heard from in this long are considered offline. */
export const RUNNER_OFFLINE_MS = 30_000

const ACTIVE_CRAWL = ['queued', 'running'] as const
const OPEN_PAGE = ['pending', 'running'] as const

export interface ClaimedJob {
  page: Page
  crawl: Crawl
}

export interface PageResult {
  httpStatus: number | null
  title: string | null
  /** Set when the page couldn't be captured; on the root page it fails the whole crawl. */
  error: string | null
  discoveredUrls: string[]
  screenshots: (CapturedScreenshot & { viewport: ViewportId })[]
  /** Root page only: the host the site actually lives on and its robots.txt. */
  hostname?: string
  robotsTxt?: string | null
}

/** Insert a crawl together with its root page, ready for a runner to claim. */
export function createCrawl(
  db: Db,
  input: Omit<CrawlInput, 'url'> & { rootUrl: string },
): string {
  const id = randomUUID()
  db.transaction(
    (tx) => {
      tx.insert(crawls)
        .values({
          id,
          rootUrl: input.rootUrl,
          hostname: new URL(input.rootUrl).hostname,
          maxDepth: input.maxDepth,
          maxPages: input.maxPages,
          viewports: input.viewports,
          respectRobots: input.respectRobots,
          pageCount: 1,
        })
        .run()
      tx.insert(pages).values({ id: randomUUID(), crawlId: id, url: input.rootUrl, depth: 0 }).run()
    },
    { behavior: 'immediate' },
  )
  return id
}

/**
 * Claim the next page to capture, or null if nothing is ready. Within a crawl,
 * pages are only handed out once every shallower page has finished, so a page's
 * parent is always one of its shallowest linkers (same as a level-by-level BFS).
 */
export function claimNextPage(db: Db, runnerId: string, now = Date.now()): ClaimedJob | null {
  return db.transaction(
    (tx) => {
      const candidate = tx.get<{ id: string } | undefined>(sql`
        select p.id from pages p join crawls c on c.id = p.crawl_id
        where p.status = 'pending' and c.status in ('queued', 'running')
          and not exists (
            select 1 from pages q
            where q.crawl_id = p.crawl_id and q.status in ('pending', 'running') and q.depth < p.depth
          )
          and (
            select count(*) from pages r where r.crawl_id = p.crawl_id and r.status = 'running'
          ) < ${MAX_IN_FLIGHT_PER_CRAWL}
        order by c.created_at, c.rowid, p.depth, p.rowid
        limit 1`)
      if (!candidate) return null

      const page = tx
        .update(pages)
        .set({
          status: 'running',
          claimedBy: runnerId,
          leaseExpiresAt: new Date(now + LEASE_MS),
          attempts: sql`${pages.attempts} + 1`,
        })
        .where(eq(pages.id, candidate.id))
        .returning()
        .get()
      tx.update(crawls)
        .set({ status: 'running' })
        .where(and(eq(crawls.id, page.crawlId), eq(crawls.status, 'queued')))
        .run()
      const crawl = tx.select().from(crawls).where(eq(crawls.id, page.crawlId)).get()!
      return { page, crawl }
    },
    { behavior: 'immediate' },
  )
}

/**
 * Record a captured (or failed) page: its screenshots, its children and its
 * links. Returns false if the page is no longer this runner's to finish (the
 * crawl was cancelled or deleted, or the lease expired and was reclaimed); the
 * caller should then discard what it captured.
 */
export function completePage(
  db: Db,
  runnerId: string,
  job: ClaimedJob,
  result: PageResult,
): boolean {
  const { page, crawl } = job
  return db.transaction(
    (tx) => {
      const owned = tx
        .update(pages)
        .set({
          status: result.error ? 'failed' : 'done',
          httpStatus: result.httpStatus,
          title: result.title,
          error: result.error,
          leaseExpiresAt: null,
        })
        .where(
          and(eq(pages.id, page.id), eq(pages.claimedBy, runnerId), eq(pages.status, 'running')),
        )
        .returning({ id: pages.id })
        .get()
      if (!owned) return false

      // A retried page may have stored some captures on an earlier attempt.
      tx.delete(screenshots).where(eq(screenshots.pageId, page.id)).run()
      for (const shot of result.screenshots) {
        tx.insert(screenshots)
          .values({ id: randomUUID(), crawlId: crawl.id, pageId: page.id, ...shot })
          .run()
      }

      if (page.depth === 0 && result.hostname) {
        tx.update(crawls)
          .set({ hostname: result.hostname, robotsTxt: result.robotsTxt ?? null })
          .where(eq(crawls.id, crawl.id))
          .run()
      }

      const urls = [...new Set(result.discoveredUrls)]
      if (page.depth < crawl.maxDepth && urls.length > 0) {
        let room =
          crawl.maxPages -
          tx.select({ n: count() }).from(pages).where(eq(pages.crawlId, crawl.id)).get()!.n
        for (const url of urls) {
          if (room <= 0) break
          const inserted = tx
            .insert(pages)
            .values({
              id: randomUUID(),
              crawlId: crawl.id,
              url,
              depth: page.depth + 1,
              parentPageId: page.id,
            })
            .onConflictDoNothing()
            .returning({ id: pages.id })
            .get()
          if (inserted) room--
        }
        tx.update(crawls)
          .set({
            pageCount: sql`(select count(*) from ${pages} where ${pages.crawlId} = ${crawl.id})`,
          })
          .where(eq(crawls.id, crawl.id))
          .run()
      }

      // Every page that will ever link-target from here already exists: shallower
      // levels are finished and this page just added its own children.
      for (let i = 0; i < urls.length; i += 500) {
        const targets = tx
          .select({ id: pages.id })
          .from(pages)
          .where(and(eq(pages.crawlId, crawl.id), inArray(pages.url, urls.slice(i, i + 500))))
          .all()
          .filter((t) => t.id !== page.id)
        if (targets.length === 0) continue
        tx.insert(links)
          .values(targets.map((t) => ({ crawlId: crawl.id, fromPageId: page.id, toPageId: t.id })))
          .onConflictDoNothing()
          .run()
      }

      settleCrawl(tx, crawl.id)
      return true
    },
    { behavior: 'immediate' },
  )
}

/** Keep this runner's claims alive and record that it's still around. */
export function heartbeat(db: Db, runnerId: string, pageIds: string[], now = Date.now()) {
  db.transaction(
    (tx) => {
      if (pageIds.length > 0) {
        tx.update(pages)
          .set({ leaseExpiresAt: new Date(now + LEASE_MS) })
          .where(
            and(
              inArray(pages.id, pageIds),
              eq(pages.claimedBy, runnerId),
              eq(pages.status, 'running'),
            ),
          )
          .run()
      }
      tx.update(runners)
        .set({ lastSeenAt: new Date(now), activeJobs: pageIds.length })
        .where(eq(runners.id, runnerId))
        .run()
    },
    { behavior: 'immediate' },
  )
}

/**
 * Hand pages whose runner went quiet back to the queue, or give up on them
 * after MAX_ATTEMPTS. Returns how many claims were reaped.
 */
export function reapExpiredLeases(db: Db, now = Date.now()): number {
  return db.transaction(
    (tx) => {
      const expired = and(eq(pages.status, 'running'), lt(pages.leaseExpiresAt, new Date(now)))
      const failed = tx
        .update(pages)
        .set({
          status: 'failed',
          error: 'Runner lost while capturing',
          leaseExpiresAt: null,
        })
        .where(and(expired, sql`${pages.attempts} >= ${MAX_ATTEMPTS}`))
        .returning({ crawlId: pages.crawlId })
        .all()
      const requeued = tx
        .update(pages)
        .set({ status: 'pending', claimedBy: null, leaseExpiresAt: null })
        .where(expired)
        .returning({ id: pages.id })
        .all()
      for (const crawlId of new Set(failed.map((f) => f.crawlId))) settleCrawl(tx, crawlId)
      return failed.length + requeued.length
    },
    { behavior: 'immediate' },
  )
}

/** Stop a crawl. Runners notice between viewports, and their late results are dropped. */
export function cancelCrawl(db: Db, crawlId: string): boolean {
  return db.transaction(
    (tx) => {
      const cancelled = tx
        .update(crawls)
        .set({ status: 'cancelled', finishedAt: new Date() })
        .where(and(eq(crawls.id, crawlId), inArray(crawls.status, ACTIVE_CRAWL)))
        .returning({ id: crawls.id })
        .get()
      if (!cancelled) return false
      tx.update(pages)
        .set({ status: 'failed', error: 'Crawl cancelled', leaseExpiresAt: null })
        .where(and(eq(pages.crawlId, crawlId), inArray(pages.status, OPEN_PAGE)))
        .run()
      return true
    },
    { behavior: 'immediate' },
  )
}

export function isCrawlActive(db: Db, crawlId: string): boolean {
  const crawl = db.select({ status: crawls.status }).from(crawls).where(eq(crawls.id, crawlId)).get()
  return !!crawl && (ACTIVE_CRAWL as readonly string[]).includes(crawl.status)
}

export function registerRunner(
  db: Db,
  runner: { id: string; hostname: string; pid: number; concurrency: number },
  now = Date.now(),
) {
  db.transaction(
    (tx) => {
      // Forget runners that died without unregistering.
      tx.delete(runners)
        .where(lt(runners.lastSeenAt, new Date(now - 10 * RUNNER_OFFLINE_MS)))
        .run()
      tx.insert(runners)
        .values({ ...runner, startedAt: new Date(now), lastSeenAt: new Date(now) })
        .onConflictDoUpdate({
          target: runners.id,
          set: { startedAt: new Date(now), lastSeenAt: new Date(now), activeJobs: 0 },
        })
        .run()
    },
    { behavior: 'immediate' },
  )
}

export function removeRunner(db: Db, runnerId: string) {
  db.delete(runners).where(eq(runners.id, runnerId)).run()
}

export function listOnlineRunners(db: Db, now = Date.now()) {
  return db
    .select()
    .from(runners)
    .where(gt(runners.lastSeenAt, new Date(now - RUNNER_OFFLINE_MS)))
    .orderBy(runners.startedAt)
    .all()
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** Finish the crawl once nothing is left to do, or fail it if its root page failed. */
function settleCrawl(tx: Tx, crawlId: string) {
  const crawl = tx.select().from(crawls).where(eq(crawls.id, crawlId)).get()
  if (!crawl || !(ACTIVE_CRAWL as readonly string[]).includes(crawl.status)) return

  const root = tx
    .select({ status: pages.status, error: pages.error })
    .from(pages)
    .where(and(eq(pages.crawlId, crawlId), eq(pages.depth, 0)))
    .get()
  if (root?.status === 'failed') {
    tx.update(crawls)
      .set({ status: 'failed', error: root.error, finishedAt: new Date() })
      .where(eq(crawls.id, crawlId))
      .run()
    tx.update(pages)
      .set({ status: 'failed', error: 'Crawl aborted', leaseExpiresAt: null })
      .where(and(eq(pages.crawlId, crawlId), inArray(pages.status, OPEN_PAGE)))
      .run()
    return
  }

  const open = tx
    .select({ n: count() })
    .from(pages)
    .where(and(eq(pages.crawlId, crawlId), inArray(pages.status, OPEN_PAGE)))
    .get()!.n
  if (open === 0) {
    tx.update(crawls)
      .set({ status: 'done', error: null, finishedAt: new Date() })
      .where(eq(crawls.id, crawlId))
      .run()
  }
}

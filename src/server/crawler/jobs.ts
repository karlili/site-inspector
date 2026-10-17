import { randomUUID } from 'node:crypto'
import { and, count, eq, gt, inArray, lt, notInArray, or, sql } from 'drizzle-orm'
import { countPages, type CrawlInput, type PageCounts, type RunnerSettings } from '#/lib/schemas'
import type { ViewportId } from '#/lib/viewports'
import type { Db } from '../db/client'
import { crawls, links, pages, runners, screenshots, type Crawl, type Page } from '../db/schema'
import { parseRobots } from './robots'
import type { CapturedScreenshot } from './screenshot'
import { getRunnerSettings } from './settings'

/**
 * The crawl queue lives in Postgres: every `pages` row is a job. Runners (any
 * number of processes sharing the database) claim one page at a time and
 * write back what it linked to. Every queue write holds the same transaction
 * lock (see `write`), so they run one at a time across processes and a page
 * is never claimed twice.
 */

/** How long a claim stays valid without a heartbeat. */
export const LEASE_MS = 60_000
/** Claims that expire this many times are given up on. */
export const MAX_ATTEMPTS = 3
/** Longest robots.txt Crawl-delay we'll honor; some sites ask for minutes. */
export const MAX_CRAWL_DELAY_MS = 60_000
/** Runners not heard from in this long are considered offline. */
export const RUNNER_OFFLINE_MS = 30_000
/**
 * Pages a crawl may never grow past, even through "go deeper" (which otherwise
 * ignores the crawl's own page limit). The board saves at most this many positions.
 */
export const MAX_PAGES_HARD = 5000
/** Pages listed only in sitemap.xml that a crawl captures, on top of its page limit. */
export const MAX_SITEMAP_PAGES = 200

/** Advisory lock id every queue write holds. */
const QUEUE_LOCK_ID = 7_401_120_002

const ACTIVE_CRAWL = ['queued', 'running'] as const
const OPEN_PAGE = ['pending', 'running'] as const
/** Puts a page back in the queue as if it had never been claimed. */
const REQUEUED = {
  status: 'pending',
  error: null,
  attempts: 0,
  claimedBy: null,
  leaseExpiresAt: null,
} as const

export interface ClaimedJob {
  page: Page
  crawl: Crawl
  /** The settings in force when the page was claimed. */
  settings: RunnerSettings
}

export interface PageResult {
  httpStatus: number | null
  title: string | null
  /** Set when the page couldn't be captured; on the root page it fails the whole crawl. */
  error: string | null
  /** The other site the page redirected to; it was captured, but its links aren't followed. */
  redirectUrl?: string
  discoveredUrls: string[]
  screenshots: (CapturedScreenshot & { viewport: ViewportId })[]
  /** Root page only: the host the site actually lives on and its robots.txt. */
  hostname?: string
  robotsTxt?: string | null
  /** Root page only: the crawlable page URLs its sitemap.xml lists. */
  sitemapUrls?: string[]
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/**
 * Run a queue write in a transaction that holds the queue lock. The claim
 * rules (levels, pages in flight, fetch delay) read state that other writes
 * change, so writes go one at a time; each is a handful of short statements.
 */
function write<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${QUEUE_LOCK_ID})`)
    return fn(tx)
  })
}

/** Insert a crawl together with its root page, ready for a runner to claim. */
export async function createCrawl(
  db: Db,
  input: Omit<CrawlInput, 'url'> & { rootUrl: string },
): Promise<string> {
  const id = randomUUID()
  await write(db, async (tx) => {
    await tx.insert(crawls).values({
      id,
      name: input.name ?? null,
      rootUrl: input.rootUrl,
      hostname: new URL(input.rootUrl).hostname,
      maxDepth: input.maxDepth,
      maxPages: input.maxPages,
      viewports: input.viewports,
      respectRobots: input.respectRobots,
      pageCount: 1,
    })
    await tx.insert(pages).values({ id: randomUUID(), crawlId: id, url: input.rootUrl, depth: 0 })
  })
  return id
}

/**
 * Claim the next page to capture, or null if nothing is ready. Within a crawl,
 * pages are only handed out once every shallower page has finished, so a page's
 * parent is always one of its shallowest linkers (same as a level-by-level BFS).
 * Each claim also holds the crawl's next one back by the fetch delay, so a site
 * sees page loads spaced out however many runners are working on it.
 */
export function claimNextPage(db: Db, runnerId: string, now = Date.now()): Promise<ClaimedJob | null> {
  return write(db, async (tx) => {
    const settings = await getRunnerSettings(tx)
    const {
      rows: [candidate],
    } = await tx.execute<{ id: string }>(sql`
      select p.id from ${pages} p join ${crawls} c on c.id = p.crawl_id
      where p.status = 'pending' and c.status in ('queued', 'running')
        and (c.next_fetch_at is null or c.next_fetch_at <= ${new Date(now)})
        and not exists (
          select 1 from ${pages} q
          where q.crawl_id = p.crawl_id and q.status in ('pending', 'running') and q.depth < p.depth
        )
        and (
          select count(*) from ${pages} r where r.crawl_id = p.crawl_id and r.status = 'running'
        ) < ${settings.maxInFlightPerCrawl}
      order by c.created_at, c.seq, p.depth, p.seq
      limit 1`)
    if (!candidate) return null

    const [page] = await tx
      .update(pages)
      .set({
        status: 'running',
        claimedBy: runnerId,
        leaseExpiresAt: new Date(now + LEASE_MS),
        attempts: sql`${pages.attempts} + 1`,
      })
      .where(eq(pages.id, candidate.id))
      .returning()
    const [{ crawlDelayMs }] = await tx
      .select({ crawlDelayMs: crawls.crawlDelayMs })
      .from(crawls)
      .where(eq(crawls.id, page.crawlId))
    const delay = Math.max(
      settings.fetchDelayMs,
      settings.honorCrawlDelay ? (crawlDelayMs ?? 0) : 0,
    )
    const [crawl] = await tx
      .update(crawls)
      .set({
        status: sql`case when ${crawls.status} = 'queued' then 'running' else ${crawls.status} end`,
        nextFetchAt: new Date(now + delay),
      })
      .where(eq(crawls.id, page.crawlId))
      .returning()
    return { page, crawl, settings }
  })
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
): Promise<boolean> {
  const { page, crawl } = job
  return write(db, async (tx) => {
    const urls = [...new Set(result.discoveredUrls)]
    // Returns the row as it is now: "go deeper" may have changed its depth limit meanwhile.
    const [owned] = await tx
      .update(pages)
      .set({
        status: result.error ? 'failed' : 'done',
        httpStatus: result.httpStatus,
        title: result.title,
        error: result.error,
        redirectUrl: result.redirectUrl ?? null,
        leaseExpiresAt: null,
        outlinks: urls,
      })
      .where(
        and(eq(pages.id, page.id), eq(pages.claimedBy, runnerId), eq(pages.status, 'running')),
      )
      .returning()
    if (!owned) return false

    // A retried page may have stored some captures on an earlier attempt.
    await tx.delete(screenshots).where(eq(screenshots.pageId, page.id))
    if (result.screenshots.length > 0) {
      await tx
        .insert(screenshots)
        .values(
          result.screenshots.map((shot) => ({
            id: randomUUID(),
            crawlId: crawl.id,
            pageId: page.id,
            ...shot,
          })),
        )
    }

    if (page.depth === 0 && result.hostname) {
      const crawlDelayMs = result.robotsTxt ? parseRobots(result.robotsTxt).crawlDelayMs : undefined
      await tx
        .update(crawls)
        .set({
          hostname: result.hostname,
          robotsTxt: result.robotsTxt ?? null,
          sitemapUrls: result.sitemapUrls?.length ? result.sitemapUrls : null,
          crawlDelayMs:
            crawlDelayMs === undefined ? null : Math.min(crawlDelayMs, MAX_CRAWL_DELAY_MS),
        })
        .where(eq(crawls.id, crawl.id))
    }

    // A refetched page replaces the links it had before.
    await tx.delete(links).where(and(eq(links.crawlId, crawl.id), eq(links.fromPageId, page.id)))
    await addOutlinks(tx, crawl.id, owned, urls)

    await settleCrawl(tx, crawl.id)
    return true
  })
}

/** Keep this runner's claims alive and record that it's still around. */
export function heartbeat(
  db: Db,
  runnerId: string,
  pageIds: string[],
  now = Date.now(),
  concurrency?: number,
): Promise<void> {
  return write(db, async (tx) => {
    if (pageIds.length > 0) {
      await tx
        .update(pages)
        .set({ leaseExpiresAt: new Date(now + LEASE_MS) })
        .where(
          and(
            inArray(pages.id, pageIds),
            eq(pages.claimedBy, runnerId),
            eq(pages.status, 'running'),
          ),
        )
    }
    await tx
      .update(runners)
      .set({ lastSeenAt: new Date(now), activeJobs: pageIds.length, concurrency })
      .where(eq(runners.id, runnerId))
  })
}

/**
 * Hand pages whose runner went quiet back to the queue, or give up on them
 * after MAX_ATTEMPTS. Returns how many claims were reaped.
 */
export function reapExpiredLeases(db: Db, now = Date.now()): Promise<number> {
  return write(db, async (tx) => {
    const expired = and(eq(pages.status, 'running'), lt(pages.leaseExpiresAt, new Date(now)))
    const failed = await tx
      .update(pages)
      .set({
        status: 'failed',
        error: 'Runner lost while capturing',
        leaseExpiresAt: null,
      })
      .where(and(expired, sql`${pages.attempts} >= ${MAX_ATTEMPTS}`))
      .returning({ crawlId: pages.crawlId })
    const requeued = await tx
      .update(pages)
      .set({ status: 'pending', claimedBy: null, leaseExpiresAt: null })
      .where(expired)
      .returning({ id: pages.id })
    for (const crawlId of new Set(failed.map((f) => f.crawlId))) await settleCrawl(tx, crawlId)
    return failed.length + requeued.length
  })
}

/** Stop a crawl. Runners notice between viewports, and their late results are dropped. */
export function cancelCrawl(db: Db, crawlId: string): Promise<boolean> {
  return write(db, (tx) => cancel(tx, crawlId))
}

/**
 * Stop a crawl and delete it with everything it found. Runners still capturing
 * its pages find them gone and discard what they captured.
 */
export function deleteCrawl(db: Db, crawlId: string): Promise<void> {
  return write(db, async (tx) => {
    await cancel(tx, crawlId)
    await tx.delete(crawls).where(eq(crawls.id, crawlId))
  })
}

async function cancel(tx: Tx, crawlId: string): Promise<boolean> {
  const [cancelled] = await tx
    .update(crawls)
    .set({ status: 'cancelled', finishedAt: new Date() })
    .where(and(eq(crawls.id, crawlId), inArray(crawls.status, ACTIVE_CRAWL)))
    .returning({ id: crawls.id })
  if (!cancelled) return false
  await tx
    .update(pages)
    .set({ status: 'cancelled', error: 'Crawl cancelled', leaseExpiresAt: null })
    .where(and(eq(pages.crawlId, crawlId), inArray(pages.status, OPEN_PAGE)))
  return true
}

/**
 * Capture a page again (and rediscover its links), reopening its crawl if it
 * had finished. Its old screenshots stay until the new ones replace them.
 * Returns false if the page is already waiting or being captured.
 */
export function refetchPage(db: Db, crawlId: string, pageId: string): Promise<boolean> {
  return write(db, async (tx) => {
    const [requeued] = await tx
      .update(pages)
      .set(REQUEUED)
      .where(
        and(eq(pages.id, pageId), eq(pages.crawlId, crawlId), notInArray(pages.status, [...OPEN_PAGE])),
      )
      .returning({ id: pages.id })
    if (!requeued) return false
    await reopenCrawl(tx, crawlId)
    return true
  })
}

/**
 * Capture a page again together with everything filed under it (its branch of
 * the parent tree), rediscovering their links. `pageIds` are the pages the
 * branch starts from. Pages already waiting or being captured are left as they
 * are. Returns how many pages were queued.
 */
export function refetchBranch(db: Db, crawlId: string, pageIds: string[]): Promise<number> {
  return write(db, async (tx) => {
    if (pageIds.length === 0) return 0
    const { rows } = await tx.execute<{ id: string }>(sql`
      with recursive branch(id) as (
        select id from ${pages}
        where crawl_id = ${crawlId} and id in (${sql.join(pageIds.map((id) => sql`${id}`), sql`, `)})
        union
        select p.id from ${pages} p join branch b on p.parent_page_id = b.id
        where p.crawl_id = ${crawlId}
      )
      select id from branch`)
    const branch = rows.map((r) => r.id)
    let queued = 0
    for (let i = 0; i < branch.length; i += 500) {
      const requeued = await tx
        .update(pages)
        .set(REQUEUED)
        .where(and(inArray(pages.id, branch.slice(i, i + 500)), notInArray(pages.status, [...OPEN_PAGE])))
        .returning({ id: pages.id })
      queued += requeued.length
    }
    if (queued > 0) await reopenCrawl(tx, crawlId)
    return queued
  })
}

/**
 * Crawl `levels` more levels below a page: everything filed under it (its
 * branch of the parent tree) may now go that much deeper than it could before.
 * Expanding the root page extends the whole crawl. Captured pages enqueue the
 * links they already found; pages captured before links were kept are
 * captured again. Expansions aren't held to the crawl's page limit.
 * Returns how many pages were queued, or null if the page doesn't exist.
 */
export function expandPage(
  db: Db,
  crawlId: string,
  pageId: string,
  levels: number,
): Promise<{ queued: number } | null> {
  return write(db, async (tx) => {
    const [crawl] = await tx.select().from(crawls).where(eq(crawls.id, crawlId))
    const [page] = await tx
      .select()
      .from(pages)
      .where(and(eq(pages.id, pageId), eq(pages.crawlId, crawlId)))
    if (!crawl || !page) return null
    const target = (page.expandToDepth ?? crawl.maxDepth) + levels

    const { rows } = await tx.execute<{ id: string }>(sql`
      with recursive branch(id) as (
        select ${pageId}::text
        union
        select p.id from ${pages} p join branch b on p.parent_page_id = b.id
        where p.crawl_id = ${crawlId}
      )
      select id from branch`)
    const branch = rows.map((r) => r.id)
    for (let i = 0; i < branch.length; i += 500) {
      await tx
        .update(pages)
        .set({
          expandToDepth: sql`greatest(coalesce(${pages.expandToDepth}, ${crawl.maxDepth}), ${target})`,
        })
        .where(inArray(pages.id, branch.slice(i, i + 500)))
    }
    if (page.depth === 0 && target > crawl.maxDepth) {
      await tx.update(crawls).set({ maxDepth: target }).where(eq(crawls.id, crawlId))
    }

    // Pages still waiting or being captured pick up the new limit when they finish.
    let queued = 0
    for (let i = 0; i < branch.length; i += 500) {
      const frontier = await tx
        .select()
        .from(pages)
        .where(
          and(
            inArray(pages.id, branch.slice(i, i + 500)),
            eq(pages.status, 'done'),
            lt(pages.depth, target),
          ),
        )
        .orderBy(pages.seq)
      for (const from of frontier) {
        if (from.outlinks) {
          queued += await addOutlinks(tx, crawlId, from, from.outlinks)
        } else {
          await tx.update(pages).set(REQUEUED).where(eq(pages.id, from.id))
          queued++
        }
      }
    }
    if (queued > 0) await reopenCrawl(tx, crawlId)
    return { queued }
  })
}

/**
 * Carry on a stopped crawl: requeue the pages Stop (or an aborted crawl)
 * interrupted, and the root page if it failed. Pages already captured are
 * kept. Returns how many pages were queued.
 */
export function resumeCrawl(db: Db, crawlId: string): Promise<number> {
  return write(db, async (tx) => {
    const [crawl] = await tx.select().from(crawls).where(eq(crawls.id, crawlId))
    if (!crawl || (ACTIVE_CRAWL as readonly string[]).includes(crawl.status)) return 0
    const resumed = await tx
      .update(pages)
      .set(REQUEUED)
      .where(
        and(
          eq(pages.crawlId, crawlId),
          or(
            eq(pages.status, 'cancelled'),
            and(eq(pages.depth, 0), eq(pages.status, 'failed')),
          ),
        ),
      )
      .returning({ id: pages.id })
    if (resumed.length > 0) await reopenCrawl(tx, crawlId)
    return resumed.length
  })
}

/**
 * Capture every page of a stopped or finished crawl again, level by level, and
 * rediscover the site's links. Pages keep their screenshots until new ones
 * replace them; pages nothing links to anymore stay on the board. Returns how
 * many pages were queued (0 while the crawl is still running).
 */
export function refetchCrawl(db: Db, crawlId: string): Promise<number> {
  return write(db, async (tx) => {
    const [crawl] = await tx.select().from(crawls).where(eq(crawls.id, crawlId))
    if (!crawl || (ACTIVE_CRAWL as readonly string[]).includes(crawl.status)) return 0
    const requeued = await tx
      .update(pages)
      .set(REQUEUED)
      .where(eq(pages.crawlId, crawlId))
      .returning({ id: pages.id })
    if (requeued.length > 0) await reopenCrawl(tx, crawlId)
    return requeued.length
  })
}

export async function isCrawlActive(db: Db, crawlId: string): Promise<boolean> {
  const [crawl] = await db.select({ status: crawls.status }).from(crawls).where(eq(crawls.id, crawlId))
  return !!crawl && (ACTIVE_CRAWL as readonly string[]).includes(crawl.status)
}

export function registerRunner(
  db: Db,
  runner: { id: string; hostname: string; pid: number; concurrency: number },
  now = Date.now(),
): Promise<void> {
  return write(db, async (tx) => {
    // Forget runners that died without unregistering.
    await tx.delete(runners).where(lt(runners.lastSeenAt, new Date(now - 10 * RUNNER_OFFLINE_MS)))
    await tx
      .insert(runners)
      .values({ ...runner, startedAt: new Date(now), lastSeenAt: new Date(now) })
      .onConflictDoUpdate({
        target: runners.id,
        set: { startedAt: new Date(now), lastSeenAt: new Date(now), activeJobs: 0 },
      })
  })
}

export async function removeRunner(db: Db, runnerId: string) {
  await db.delete(runners).where(eq(runners.id, runnerId))
}

export function listOnlineRunners(db: Db, now = Date.now()) {
  return db
    .select()
    .from(runners)
    .where(gt(runners.lastSeenAt, new Date(now - RUNNER_OFFLINE_MS)))
    .orderBy(runners.startedAt)
}

/** How many pages of each crawl are in each status. */
export async function countCrawlPages(db: Db | Tx, crawlIds: string[]): Promise<Map<string, PageCounts>> {
  const counts = new Map(crawlIds.map((id) => [id, countPages([])]))
  if (crawlIds.length === 0) return counts
  const rows = await db
    .select({ crawlId: pages.crawlId, status: pages.status, n: count() })
    .from(pages)
    .where(inArray(pages.crawlId, crawlIds))
    .groupBy(pages.crawlId, pages.status)
  for (const { crawlId, status, n } of rows) counts.get(crawlId)![status] = n
  return counts
}

export interface QueuedPage {
  id: string
  url: string
  depth: number
  /** Times it has been claimed; above 0 on a waiting page, a runner lost it before. */
  attempts: number
}

export interface CrawlQueue {
  crawl: Pick<Crawl, 'id' | 'name' | 'rootUrl' | 'status'>
  counts: PageCounts
  /** The shallowest level with pages still open; nothing deeper is handed out until it's done. */
  level: number | null
  /** Pages runners are capturing now, with the host of the runner holding each. */
  running: (QueuedPage & { runnerId: string | null; runnerHost: string | null })[]
  /** The first waiting pages, in the order runners will claim them. */
  waiting: QueuedPage[]
}

/**
 * What runners are capturing and what's waiting for them, for every active
 * crawl (or just `crawlId`), oldest crawl first as runners serve them. Lists
 * at most `limit` waiting pages per crawl; `counts` has the full numbers.
 */
export function listQueue(
  db: Db,
  { crawlId, limit = 200 }: { crawlId?: string; limit?: number } = {},
): Promise<CrawlQueue[]> {
  // One snapshot, so the counts agree with the lists.
  return db.transaction(
    async (tx) => {
      const active = await tx
        .select({ id: crawls.id, name: crawls.name, rootUrl: crawls.rootUrl, status: crawls.status })
        .from(crawls)
        .where(and(inArray(crawls.status, ACTIVE_CRAWL), crawlId ? eq(crawls.id, crawlId) : undefined))
        .orderBy(crawls.createdAt, crawls.seq)
      if (active.length === 0) return []
      const ids = active.map((c) => c.id)

      // One after another: the transaction has a single connection.
      const counts = await countCrawlPages(tx, ids)
      const running = await tx
        .select({
          id: pages.id,
          crawlId: pages.crawlId,
          url: pages.url,
          depth: pages.depth,
          attempts: pages.attempts,
          runnerId: pages.claimedBy,
          runnerHost: runners.hostname,
        })
        .from(pages)
        .leftJoin(runners, eq(runners.id, pages.claimedBy))
        .where(and(inArray(pages.crawlId, ids), eq(pages.status, 'running')))
        .orderBy(pages.depth, pages.seq)
      const { rows: waiting } = await tx.execute<{
        id: string
        crawl_id: string
        url: string
        depth: number
        attempts: number
      }>(sql`
        select id, crawl_id, url, depth, attempts from (
          select p.id, p.crawl_id, p.url, p.depth, p.attempts, p.seq,
            row_number() over (partition by p.crawl_id order by p.depth, p.seq) as position
          from ${pages} p
          where p.status = 'pending'
            and p.crawl_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        ) w
        where position <= ${limit}
        order by depth, seq`)

      return active.map((crawl): CrawlQueue => {
        const own = running.filter((p) => p.crawlId === crawl.id).map(({ crawlId: _, ...p }) => p)
        const queued = waiting
          .filter((p) => p.crawl_id === crawl.id)
          .map(({ id, url, depth, attempts }) => ({ id, url, depth, attempts }))
        const depths = [...own, ...queued].map((p) => p.depth)
        return {
          crawl,
          counts: counts.get(crawl.id)!,
          level: depths.length ? Math.min(...depths) : null,
          running: own,
          waiting: queued,
        }
      })
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  )
}

/**
 * Enqueue the pages `from` links to, if its branch may go deeper, and record
 * its links to every page of the crawl it points at. Returns how many pages
 * were added.
 */
async function addOutlinks(
  tx: Tx,
  crawlId: string,
  from: Pick<Page, 'id' | 'depth' | 'expandToDepth'>,
  urls: string[],
): Promise<number> {
  const [crawl] = await tx.select().from(crawls).where(eq(crawls.id, crawlId))
  const added: string[] = []
  if (from.depth < (from.expandToDepth ?? crawl.maxDepth) && urls.length > 0) {
    const limit = from.expandToDepth == null ? Math.min(crawl.maxPages, MAX_PAGES_HARD) : MAX_PAGES_HARD
    const [{ n }] = await tx.select({ n: count() }).from(pages).where(eq(pages.crawlId, crawlId))
    let room = limit - n
    for (const url of urls) {
      if (room <= 0) break
      const [inserted] = await tx
        .insert(pages)
        .values({
          id: randomUUID(),
          crawlId,
          url,
          depth: from.depth + 1,
          parentPageId: from.id,
          expandToDepth: from.expandToDepth,
        })
        .onConflictDoNothing()
        .returning({ id: pages.id })
      if (inserted) {
        added.push(inserted.id)
        room--
      }
    }
    await tx
      .update(crawls)
      .set({ pageCount: sql`(select count(*) from ${pages} where ${pages.crawlId} = ${crawlId})` })
      .where(eq(crawls.id, crawlId))
  }

  for (let i = 0; i < urls.length; i += 500) {
    const targets = (
      await tx
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.crawlId, crawlId), inArray(pages.url, urls.slice(i, i + 500))))
    ).filter((t) => t.id !== from.id)
    if (targets.length === 0) continue
    await tx
      .insert(links)
      .values(targets.map((t) => ({ crawlId, fromPageId: from.id, toPageId: t.id })))
      .onConflictDoNothing()
  }

  // Level by level, every page linking to a new one is captured after it exists.
  // Going deeper adds pages that earlier captures already linked to; link those too.
  if (from.expandToDepth != null) {
    for (let i = 0; i < added.length; i += 500) {
      await tx.execute(sql`
        insert into ${links} (crawl_id, from_page_id, to_page_id)
        select ${crawlId}::text, p.id, n.id
        from ${pages} p
        cross join lateral jsonb_array_elements_text(p.outlinks) j(value)
        join ${pages} n on n.crawl_id = ${crawlId} and n.url = j.value
        where p.crawl_id = ${crawlId} and p.outlinks is not null and p.id != n.id
          and n.id in (${sql.join(added.slice(i, i + 500).map((id) => sql`${id}`), sql`, `)})
        on conflict do nothing`)
    }
  }
  return added.length
}

/** Put a finished crawl back in the queue; settleCrawl finishes it again once nothing is open. */
async function reopenCrawl(tx: Tx, crawlId: string) {
  await tx
    .update(crawls)
    .set({ status: 'queued', error: null, finishedAt: null })
    .where(and(eq(crawls.id, crawlId), notInArray(crawls.status, [...ACTIVE_CRAWL])))
}

/** Finish the crawl once nothing is left to do, or fail it if its root page failed. */
async function settleCrawl(tx: Tx, crawlId: string) {
  const [crawl] = await tx.select().from(crawls).where(eq(crawls.id, crawlId))
  if (!crawl || !(ACTIVE_CRAWL as readonly string[]).includes(crawl.status)) return

  const [root] = await tx
    .select({ status: pages.status, error: pages.error })
    .from(pages)
    .where(and(eq(pages.crawlId, crawlId), eq(pages.depth, 0)))
  if (root?.status === 'failed') {
    await tx
      .update(crawls)
      .set({ status: 'failed', error: root.error, finishedAt: new Date() })
      .where(eq(crawls.id, crawlId))
    await tx
      .update(pages)
      .set({ status: 'cancelled', error: 'Crawl aborted', leaseExpiresAt: null })
      .where(and(eq(pages.crawlId, crawlId), inArray(pages.status, OPEN_PAGE)))
    return
  }

  const [{ open }] = await tx
    .select({ open: count() })
    .from(pages)
    .where(and(eq(pages.crawlId, crawlId), inArray(pages.status, OPEN_PAGE)))
  if (open === 0) {
    // Captured last, once nothing left to crawl could still link to them.
    if ((await addSitemapOrphans(tx, crawl)) > 0) return
    await tx
      .update(crawls)
      .set({ status: 'done', error: null, finishedAt: new Date() })
      .where(eq(crawls.id, crawlId))
  }
}

/**
 * Queue the pages sitemap.xml lists that no crawled page links to: orphans.
 * URLs a captured page links to are skipped even when the crawl didn't go deep
 * enough to capture them; they're reachable. Their depth is the crawl's limit
 * (but never 0, which marks the start page), so their own links are recorded
 * but don't queue more pages.
 */
async function addSitemapOrphans(tx: Tx, crawl: Crawl): Promise<number> {
  if (!crawl.sitemapUrls?.length) return 0
  const [existing] = await tx
    .select({
      total: count(),
      fromSitemap: count(sql`case when ${pages.source} = 'sitemap' then 1 end`),
    })
    .from(pages)
    .where(eq(pages.crawlId, crawl.id))
  const room = Math.min(MAX_SITEMAP_PAGES - existing.fromSitemap, MAX_PAGES_HARD - existing.total)
  if (room <= 0) return 0

  const { rows: orphans } = await tx.execute<{ url: string }>(sql`
    select s.value as url
    from jsonb_array_elements_text(${JSON.stringify(crawl.sitemapUrls)}::jsonb) with ordinality s(value, n)
    where s.value not in (select url from ${pages} where crawl_id = ${crawl.id})
      and s.value not in (
        select o.value from ${pages} p
        cross join lateral jsonb_array_elements_text(p.outlinks) o(value)
        where p.crawl_id = ${crawl.id} and p.outlinks is not null
      )
    order by s.n
    limit ${room}`)
  if (orphans.length === 0) return 0

  await tx
    .insert(pages)
    .values(
      orphans.map(({ url }) => ({
        id: randomUUID(),
        crawlId: crawl.id,
        url,
        depth: Math.max(1, crawl.maxDepth),
        source: 'sitemap' as const,
      })),
    )
    .onConflictDoNothing()
  await tx
    .update(crawls)
    .set({ pageCount: sql`(select count(*) from ${pages} where ${pages.crawlId} = ${crawl.id})` })
    .where(eq(crawls.id, crawl.id))
  return orphans.length
}

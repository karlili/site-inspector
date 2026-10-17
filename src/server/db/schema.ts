import { relations } from 'drizzle-orm'
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { crawlStatuses, pageSources, pageStatuses } from '#/lib/schemas'
import type { ViewportId } from '#/lib/viewports'

const timestampMs = (name: string) => timestamp(name, { withTimezone: true, precision: 3 })
/** Insertion order, for breaking ties between rows created at the same moment. */
const seq = () => bigint({ mode: 'number' }).generatedAlwaysAsIdentity().notNull()

export const crawls = pgTable('crawls', {
  id: text().primaryKey(),
  seq: seq(),
  /** Set by the user; null shows the crawl by its start URL. */
  name: text(),
  rootUrl: text('root_url').notNull(),
  hostname: text().notNull(),
  maxDepth: integer('max_depth').notNull(),
  maxPages: integer('max_pages').notNull(),
  viewports: jsonb().$type<ViewportId[]>().notNull(),
  respectRobots: boolean('respect_robots').notNull(),
  status: text({ enum: crawlStatuses }).notNull().default('queued'),
  error: text(),
  pageCount: integer('page_count').notNull().default(0),
  /** Fetched by the root page's job; null means no rules (allow everything). */
  robotsTxt: text('robots_txt'),
  /** The robots.txt Crawl-delay, if it set one. */
  crawlDelayMs: integer('crawl_delay_ms'),
  /** Same-site page URLs the site's sitemap.xml lists, fetched by the root page's job. */
  sitemapUrls: jsonb('sitemap_urls').$type<string[]>(),
  /** The earliest a runner may start loading this crawl's next page. */
  nextFetchAt: timestampMs('next_fetch_at'),
  createdAt: timestampMs('created_at').notNull().defaultNow(),
  finishedAt: timestampMs('finished_at'),
})

export const pages = pgTable(
  'pages',
  {
    id: text().primaryKey(),
    seq: seq(),
    crawlId: text('crawl_id')
      .notNull()
      .references(() => crawls.id, { onDelete: 'cascade' }),
    url: text().notNull(),
    title: text(),
    depth: integer().notNull(),
    parentPageId: text('parent_page_id'),
    httpStatus: integer('http_status'),
    status: text({ enum: pageStatuses }).notNull().default('pending'),
    error: text(),
    /** The other site this page redirected to; its screenshots show that page. */
    redirectUrl: text('redirect_url'),
    posX: doublePrecision('pos_x'),
    posY: doublePrecision('pos_y'),
    /** Each page is a job: the runner holding it and until when its lease is valid. */
    claimedBy: text('claimed_by'),
    leaseExpiresAt: timestampMs('lease_expires_at'),
    attempts: integer().notNull().default(0),
    /** Every same-site URL the page linked to, kept even when its children weren't enqueued. */
    outlinks: jsonb().$type<string[]>(),
    /** Set by "go deeper": how deep this page's branch may go, instead of the crawl's max depth. */
    expandToDepth: integer('expand_to_depth'),
    source: text({ enum: pageSources }).notNull().default('link'),
  },
  (t) => [
    uniqueIndex('pages_crawl_url_idx').on(t.crawlId, t.url),
    index('pages_crawl_idx').on(t.crawlId),
    index('pages_queue_idx').on(t.status, t.crawlId, t.depth),
    index('pages_parent_idx').on(t.parentPageId),
  ],
)

export const links = pgTable(
  'links',
  {
    crawlId: text('crawl_id')
      .notNull()
      .references(() => crawls.id, { onDelete: 'cascade' }),
    fromPageId: text('from_page_id').notNull(),
    toPageId: text('to_page_id').notNull(),
  },
  (t) => [
    uniqueIndex('links_unique_idx').on(t.crawlId, t.fromPageId, t.toPageId),
  ],
)

export const screenshots = pgTable(
  'screenshots',
  {
    id: text().primaryKey(),
    crawlId: text('crawl_id')
      .notNull()
      .references(() => crawls.id, { onDelete: 'cascade' }),
    pageId: text('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
    viewport: text().$type<ViewportId>().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    /** Storage keys (see server/storage), relative to the screenshot store's root. */
    filePath: text('file_path').notNull(),
    thumbPath: text('thumb_path').notNull(),
  },
  (t) => [
    index('screenshots_page_idx').on(t.pageId),
    index('screenshots_crawl_idx').on(t.crawlId),
  ],
)

/** Runner processes, so the admin can tell whether anything is picking up work. */
export const runners = pgTable('runners', {
  id: text().primaryKey(),
  hostname: text().notNull(),
  pid: integer().notNull(),
  concurrency: integer().notNull(),
  activeJobs: integer('active_jobs').notNull().default(0),
  startedAt: timestampMs('started_at').notNull(),
  lastSeenAt: timestampMs('last_seen_at').notNull(),
})

/** Admin-editable settings, one JSON value per key (e.g. 'runner'). */
export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: timestampMs('updated_at').notNull(),
})

export const crawlsRelations = relations(crawls, ({ many }) => ({
  pages: many(pages),
}))

export const pagesRelations = relations(pages, ({ one, many }) => ({
  crawl: one(crawls, { fields: [pages.crawlId], references: [crawls.id] }),
  screenshots: many(screenshots),
}))

export const screenshotsRelations = relations(screenshots, ({ one }) => ({
  page: one(pages, { fields: [screenshots.pageId], references: [pages.id] }),
}))

export type Crawl = typeof crawls.$inferSelect
export type Page = typeof pages.$inferSelect
export type Screenshot = typeof screenshots.$inferSelect
export type Link = typeof links.$inferSelect
export type Runner = typeof runners.$inferSelect

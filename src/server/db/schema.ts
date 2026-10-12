import { relations, sql } from 'drizzle-orm'
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { crawlStatuses, pageStatuses } from '#/lib/schemas'
import type { ViewportId } from '#/lib/viewports'

export const crawls = sqliteTable('crawls', {
  id: text().primaryKey(),
  rootUrl: text('root_url').notNull(),
  hostname: text().notNull(),
  maxDepth: integer('max_depth').notNull(),
  maxPages: integer('max_pages').notNull(),
  viewports: text({ mode: 'json' }).$type<ViewportId[]>().notNull(),
  respectRobots: integer('respect_robots', { mode: 'boolean' }).notNull(),
  status: text({ enum: crawlStatuses }).notNull().default('queued'),
  error: text(),
  pageCount: integer('page_count').notNull().default(0),
  /** Fetched by the root page's job; null means no rules (allow everything). */
  robotsTxt: text('robots_txt'),
  /** The robots.txt Crawl-delay, if it set one. */
  crawlDelayMs: integer('crawl_delay_ms'),
  /** The earliest a runner may start loading this crawl's next page. */
  nextFetchAt: integer('next_fetch_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  finishedAt: integer('finished_at', { mode: 'timestamp' }),
})

export const pages = sqliteTable(
  'pages',
  {
    id: text().primaryKey(),
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
    posX: real('pos_x'),
    posY: real('pos_y'),
    /** Each page is a job: the runner holding it and until when its lease is valid. */
    claimedBy: text('claimed_by'),
    leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp_ms' }),
    attempts: integer().notNull().default(0),
  },
  (t) => [
    uniqueIndex('pages_crawl_url_idx').on(t.crawlId, t.url),
    index('pages_crawl_idx').on(t.crawlId),
    index('pages_queue_idx').on(t.status, t.crawlId, t.depth),
  ],
)

export const links = sqliteTable(
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

export const screenshots = sqliteTable(
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
    filePath: text('file_path').notNull(),
    thumbPath: text('thumb_path').notNull(),
  },
  (t) => [index('screenshots_page_idx').on(t.pageId)],
)

/** Runner processes, so the admin can tell whether anything is picking up work. */
export const runners = sqliteTable('runners', {
  id: text().primaryKey(),
  hostname: text().notNull(),
  pid: integer().notNull(),
  concurrency: integer().notNull(),
  activeJobs: integer('active_jobs').notNull().default(0),
  startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
})

/** Admin-editable settings, one JSON value per key (e.g. 'runner'). */
export const settings = sqliteTable('settings', {
  key: text().primaryKey(),
  value: text({ mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
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

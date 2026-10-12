import { z } from 'zod'
import { VIEWPORT_IDS } from './viewports'

export const MAX_DEPTH = 5

export const viewportSchema = z.enum(VIEWPORT_IDS)

export const crawlInputSchema = z.object({
  url: z
    .url({ protocol: /^https?$/, message: 'Enter an http(s) URL' })
    .trim(),
  maxDepth: z.coerce.number().int().min(0).max(MAX_DEPTH),
  viewports: z.array(viewportSchema).min(1, 'Pick at least one screen size'),
  maxPages: z.coerce.number().int().min(1).max(1000).default(200),
  respectRobots: z.boolean().default(true),
})
export type CrawlInput = z.infer<typeof crawlInputSchema>

export const crawlIdSchema = z.object({ crawlId: z.string().min(1) })

export const pageRefSchema = z.object({ crawlId: z.string().min(1), pageId: z.string().min(1) })

export const expandPageSchema = pageRefSchema.extend({
  levels: z.int().min(1).max(MAX_DEPTH),
})

/** How runners behave; edited on the settings page and read by every runner live. */
export const runnerSettingsSchema = z.object({
  /** Minimum time between starting two page loads of the same crawl, across all runners. */
  fetchDelayMs: z.number().int().min(0).max(60_000).default(1000),
  /** Pages of one crawl being captured at once, across all runners. */
  maxInFlightPerCrawl: z.number().int().min(1).max(50).default(6),
  /** Pages each runner captures at once, unless it was started with RUNNER_CONCURRENCY. */
  slotsPerRunner: z.number().int().min(1).max(32).default(3),
  navTimeoutMs: z.number().int().min(5_000).max(120_000).default(30_000),
  /** Wait at least as long as the site's robots.txt Crawl-delay asks for. */
  honorCrawlDelay: z.boolean().default(true),
})
export type RunnerSettings = z.infer<typeof runnerSettingsSchema>
export const DEFAULT_RUNNER_SETTINGS = runnerSettingsSchema.parse({})

export const crawlStatuses = ['queued', 'running', 'done', 'failed', 'cancelled'] as const
export type CrawlStatus = (typeof crawlStatuses)[number]

/** `cancelled`: interrupted by Stop or an aborted crawl; Resume picks it up again. */
export const pageStatuses = ['pending', 'running', 'done', 'failed', 'cancelled'] as const
export type PageStatus = (typeof pageStatuses)[number]

/** Waiting for a runner, or being captured by one. */
export const isPageOpen = (status: PageStatus) => status === 'pending' || status === 'running'

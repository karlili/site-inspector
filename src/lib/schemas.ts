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

export const nodePositionsSchema = z.object({
  crawlId: z.string().min(1),
  positions: z
    .array(
      z.object({
        pageId: z.string().min(1),
        x: z.number().finite(),
        y: z.number().finite(),
      }),
    )
    .max(5000),
})

export const crawlStatuses = ['queued', 'running', 'done', 'failed', 'cancelled'] as const
export type CrawlStatus = (typeof crawlStatuses)[number]

export const pageStatuses = ['pending', 'running', 'done', 'failed'] as const
export type PageStatus = (typeof pageStatuses)[number]

/** Waiting for a runner, or being captured by one. */
export const isPageOpen = (status: PageStatus) => status === 'pending' || status === 'running'

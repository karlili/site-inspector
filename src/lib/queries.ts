import { queryOptions } from '@tanstack/react-query'
import { getCrawl, listCrawls, listRunners } from '#/server/functions/crawls'
import type { CrawlStatus } from './schemas'

export const isActive = (status: CrawlStatus) => status === 'queued' || status === 'running'

export const crawlsQuery = () =>
  queryOptions({
    queryKey: ['crawls'],
    queryFn: () => listCrawls(),
    refetchInterval: (query) =>
      query.state.data?.some((c) => isActive(c.status)) ? 2000 : false,
  })

export const crawlQuery = (crawlId: string) =>
  queryOptions({
    queryKey: ['crawls', crawlId],
    queryFn: () => getCrawl({ data: { crawlId } }),
    refetchInterval: (query) => {
      const status = query.state.data?.crawl.status
      return status && isActive(status) ? 2000 : false
    },
  })

export const runnersQuery = () =>
  queryOptions({
    queryKey: ['runners'],
    queryFn: () => listRunners(),
    refetchInterval: 5000,
  })

export type CrawlDetail = Awaited<ReturnType<typeof getCrawl>>

export const screenshotUrl = (relPath: string) =>
  `/screenshots/${relPath.split('/').map(encodeURIComponent).join('/')}`

import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ProgressBar, progressSummary } from '#/components/QueueSheet'
import { StatusBadge } from '#/components/StatusBadge'
import { Button } from '#/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import { crawlTitle, crawlsQuery } from '#/lib/queries'
import { VIEWPORTS } from '#/lib/viewports'
import { deleteCrawl } from '#/server/functions/crawls'

export function CrawlTable() {
  const { data: crawls } = useSuspenseQuery(crawlsQuery())
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: deleteCrawl,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['crawls'] }),
    onError: (err) => toast.error(err.message),
  })

  if (crawls.length === 0) {
    return <p className="text-muted-foreground text-sm">No crawls yet.</p>
  }

  return (
    <div className="border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Site</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Depth</TableHead>
            <TableHead className="text-right">Pages</TableHead>
            <TableHead>Screens</TableHead>
            <TableHead>Started</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {crawls.map((crawl) => (
            <TableRow key={crawl.id}>
              <TableCell className="max-w-80 truncate font-medium">
                <Link
                  to="/crawls/$crawlId"
                  params={{ crawlId: crawl.id }}
                  className="hover:underline"
                >
                  {crawlTitle(crawl)}
                </Link>
                {crawl.name && (
                  <div className="text-muted-foreground truncate text-xs font-normal">
                    {crawl.rootUrl}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <StatusBadge status={crawl.status} />
                {crawl.progress && (
                  <div className="mt-1.5 grid w-32 gap-1" title={progressSummary(crawl.progress)}>
                    <ProgressBar counts={crawl.progress} />
                    <span className="text-muted-foreground truncate text-xs tabular-nums">
                      {progressSummary(crawl.progress, { short: true })}
                    </span>
                  </div>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{crawl.maxDepth}</TableCell>
              <TableCell className="text-right tabular-nums">{crawl.pageCount}</TableCell>
              <TableCell className="text-muted-foreground">
                {crawl.viewports.map((v) => VIEWPORTS[v].label).join(', ')}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {new Date(crawl.createdAt).toLocaleString()}
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Delete crawl"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ data: { crawlId: crawl.id } })}
                >
                  <Trash2 />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

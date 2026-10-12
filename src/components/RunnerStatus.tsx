import { useQuery } from '@tanstack/react-query'
import { TriangleAlert } from 'lucide-react'
import { runnersQuery } from '#/lib/queries'
import { cn } from '#/lib/utils'

/**
 * Crawls are captured by separate runner processes. Shows how many are online,
 * or, with `onlyWhenMissing`, nothing unless work is waiting on a runner.
 */
export function RunnerStatus({
  onlyWhenMissing = false,
  className,
}: {
  onlyWhenMissing?: boolean
  className?: string
}) {
  const { data: runners } = useQuery(runnersQuery())
  if (!runners) return null

  if (runners.length === 0) {
    return (
      <p className={cn('text-destructive flex items-center gap-1.5 text-xs', className)}>
        <TriangleAlert className="size-3.5 shrink-0" />
        <span>
          No runner online. Start one with <code className="font-mono">pnpm runner</code>.
        </span>
      </p>
    )
  }
  if (onlyWhenMissing) return null

  const slots = runners.reduce((sum, r) => sum + r.concurrency, 0)
  const busy = runners.reduce((sum, r) => sum + r.activeJobs, 0)
  return (
    <p
      className={cn('text-muted-foreground flex items-center gap-1.5 text-xs', className)}
      title={runners.map((r) => r.id).join('\n')}
    >
      <span className="size-2 shrink-0 bg-emerald-500" aria-hidden />
      {runners.length} {runners.length === 1 ? 'runner' : 'runners'} online · {busy}/{slots} slots busy
    </p>
  )
}

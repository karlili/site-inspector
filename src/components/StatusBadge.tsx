import { Loader2 } from 'lucide-react'
import { Badge } from '#/components/ui/badge'
import type { CrawlStatus, PageStatus } from '#/lib/schemas'

const VARIANTS: Record<CrawlStatus | PageStatus, React.ComponentProps<typeof Badge>['variant']> = {
  queued: 'outline',
  pending: 'outline',
  running: 'secondary',
  done: 'default',
  failed: 'destructive',
  cancelled: 'outline',
}

export function StatusBadge({ status }: { status: CrawlStatus | PageStatus }) {
  return (
    <Badge variant={VARIANTS[status]} className="uppercase tracking-wide">
      {(status === 'running' || status === 'pending') && <Loader2 className="animate-spin" />}
      {status}
    </Badge>
  )
}

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ListOrdered, Loader2, RotateCcw } from 'lucide-react'
import { RunnerStatus } from '#/components/RunnerStatus'
import { StatusBadge } from '#/components/StatusBadge'
import { pathOf } from '#/components/sitemap/useBoard'
import { Button } from '#/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '#/components/ui/sheet'
import { crawlTitle, queueQuery, type CrawlQueue } from '#/lib/queries'
import type { PageCounts } from '#/lib/schemas'
import { cn } from '#/lib/utils'

const total = (counts: PageCounts) => Object.values(counts).reduce((sum, n) => sum + n, 0)

/** Captured and failed pages, then the ones being captured, out of all the crawl's pages. */
export function ProgressBar({ counts, className }: { counts: PageCounts; className?: string }) {
  const all = total(counts) || 1
  const pct = (n: number) => `${(n / all) * 100}%`
  return (
    <div
      className={cn('bg-muted flex h-1 overflow-hidden', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={all}
      aria-valuenow={counts.done + counts.failed}
    >
      <div className="bg-primary h-full transition-[width] duration-500" style={{ width: pct(counts.done) }} />
      <div className="bg-destructive h-full transition-[width] duration-500" style={{ width: pct(counts.failed) }} />
      <div
        className="bg-primary/40 h-full animate-pulse transition-[width] duration-500"
        style={{ width: pct(counts.running) }}
      />
    </div>
  )
}

/** "12/40 captured · 3 capturing · 25 waiting"; `short` leaves out what's failed and being captured. */
export function progressSummary(counts: PageCounts, { short = false } = {}) {
  const parts = [`${counts.done + counts.failed}/${total(counts)}${short ? '' : ' captured'}`]
  if (counts.failed && !short) parts.push(`${counts.failed} failed`)
  if (counts.running && !short) parts.push(`${counts.running} capturing`)
  if (counts.pending) parts.push(`${counts.pending} waiting`)
  return parts.join(' · ')
}

/**
 * A button showing how much work is in flight, opening a panel that lists what
 * runners are capturing and what's waiting for them, in the order they'll
 * pick it up. Covers every active crawl, or only `crawlId`.
 */
export function QueueSheet({
  crawlId,
  counts,
  onPick,
}: {
  crawlId?: string
  counts: PageCounts
  /** Called with a page's id when its row is clicked; the panel closes. */
  onPick?: (pageId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const { data: queues } = useQuery({ ...queueQuery(crawlId), enabled: open })

  const pick = onPick && ((pageId: string) => {
    setOpen(false)
    onPick(pageId)
  })

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm" title="Pages being captured and waiting for a runner">
          <ListOrdered />
          Queue
          <span className="text-muted-foreground tabular-nums">
            {counts.running} capturing · {counts.pending} waiting
          </span>
        </Button>
      </SheetTrigger>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b pr-10">
          <SheetTitle>Queue</SheetTitle>
          <SheetDescription>
            {crawlId
              ? 'Pages of this crawl being captured, and the ones waiting in the order runners will pick them up.'
              : 'Pages being captured, and the ones waiting in the order runners will pick them up. Runners serve the oldest crawl first.'}
          </SheetDescription>
          <RunnerStatus />
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!queues ? (
            <p className="text-muted-foreground flex items-center gap-2 p-4 text-sm">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </p>
          ) : queues.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm">Nothing waiting for a runner.</p>
          ) : (
            queues.map((queue) => (
              <CrawlQueueSection key={queue.crawl.id} queue={queue} showCrawl={!crawlId} onPick={pick} />
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function CrawlQueueSection({
  queue,
  showCrawl,
  onPick,
}: {
  queue: CrawlQueue
  showCrawl: boolean
  onPick?: (pageId: string) => void
}) {
  const { crawl, counts, level, running, waiting } = queue
  // Waiting pages come shallowest level first, as runners claim them.
  const levels = new Map<number, typeof waiting>()
  for (const page of waiting) {
    if (!levels.has(page.depth)) levels.set(page.depth, [])
    levels.get(page.depth)!.push(page)
  }
  let position = 0

  return (
    <section className="grid grid-cols-[minmax(0,1fr)] gap-3 border-b p-4">
      {showCrawl && (
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to="/crawls/$crawlId"
            params={{ crawlId: crawl.id }}
            className="min-w-0 truncate text-sm font-medium hover:underline"
          >
            {crawlTitle(crawl)}
          </Link>
          <StatusBadge status={crawl.status} />
        </div>
      )}
      <div className="grid gap-1.5">
        <ProgressBar counts={counts} />
        <p className="text-muted-foreground text-xs tabular-nums">{progressSummary(counts)}</p>
      </div>

      <QueueGroup title="Capturing now" count={counts.running}>
        {running.length === 0 ? (
          <p className="text-muted-foreground px-2 text-xs">No runner is on this crawl right now.</p>
        ) : (
          running.map((page) => (
            <QueueRow
              key={page.id}
              page={page}
              marker={<Loader2 className="size-3 animate-spin" />}
              note={page.runnerHost ?? undefined}
              noteTitle={page.runnerId ? `Runner ${page.runnerId}` : undefined}
              onPick={onPick}
            />
          ))
        )}
      </QueueGroup>

      {[...levels].map(([depth, pages]) => (
        <QueueGroup
          key={depth}
          title={`Level ${depth}`}
          detail={depth === level || level === null ? 'next up' : `after level ${level} finishes`}
          count={pages.length}
          muted={level !== null && depth > level}
        >
          {pages.map((page) => (
            <QueueRow
              key={page.id}
              page={page}
              marker={<span className="tabular-nums">{++position}</span>}
              note={page.attempts > 0 ? 'retry' : undefined}
              noteTitle={page.attempts > 0 ? 'A runner was lost while capturing it; it will be tried again' : undefined}
              noteIcon={page.attempts > 0}
              onPick={onPick}
            />
          ))}
        </QueueGroup>
      ))}
      {counts.pending > waiting.length && (
        <p className="text-muted-foreground px-2 text-xs">
          …and {counts.pending - waiting.length} more waiting
        </p>
      )}
    </section>
  )
}

function QueueGroup({
  title,
  detail,
  count,
  muted,
  children,
}: {
  title: string
  detail?: string
  count: number
  muted?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={cn('grid grid-cols-[minmax(0,1fr)] gap-0.5', muted && 'opacity-60')}>
      <h3 className="text-muted-foreground flex items-baseline gap-1.5 px-2 text-xs font-medium uppercase tracking-wide">
        {title}
        <span className="tabular-nums">({count})</span>
        {detail && <span className="font-normal normal-case tracking-normal">· {detail}</span>}
      </h3>
      {children}
    </div>
  )
}

function QueueRow({
  page,
  marker,
  note,
  noteTitle,
  noteIcon,
  onPick,
}: {
  page: CrawlQueue['waiting'][number]
  marker: React.ReactNode
  note?: string
  noteTitle?: string
  noteIcon?: boolean
  onPick?: (pageId: string) => void
}) {
  const content = (
    <>
      <span className="text-muted-foreground flex w-6 shrink-0 justify-end text-xs">{marker}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{pathOf(page.url)}</span>
      {note && (
        <span className="text-muted-foreground flex shrink-0 items-center gap-1 text-xs" title={noteTitle}>
          {noteIcon && <RotateCcw className="size-3" />}
          {note}
        </span>
      )}
    </>
  )
  const className = 'flex h-7 items-center gap-2 px-2 text-left'
  if (!onPick) {
    return (
      <div className={className} title={page.url}>
        {content}
      </div>
    )
  }
  return (
    <button
      type="button"
      className={cn(className, 'hover:bg-accent hover:text-accent-foreground')}
      title={`${page.url}\nShow on the board`}
      onClick={() => onPick(page.id)}
    >
      {content}
    </button>
  )
}

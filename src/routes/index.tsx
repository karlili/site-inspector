import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ScanSearch, Settings } from 'lucide-react'
import { CrawlTable } from '#/components/CrawlTable'
import { NewCrawlForm } from '#/components/NewCrawlForm'
import { QueueSheet } from '#/components/QueueSheet'
import { RunnerStatus } from '#/components/RunnerStatus'
import { ThemeToggle } from '#/components/ThemeToggle'
import { Button } from '#/components/ui/button'
import { crawlsQuery } from '#/lib/queries'
import { countPages, pageStatuses } from '#/lib/schemas'

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(crawlsQuery()),
  component: Home,
})

function Home() {
  const { data: crawls } = useSuspenseQuery(crawlsQuery())
  // Pages of every active crawl, for the queue button.
  const active = crawls.flatMap((c) => (c.progress ? [c.progress] : []))
  const queued = countPages([])
  for (const progress of active) for (const status of pageStatuses) queued[status] += progress[status]

  return (
    <main className="mx-auto grid max-w-5xl gap-8 px-4 py-10">
      <header className="flex items-center gap-3">
        <ScanSearch className="size-7" />
        <h1 className="text-2xl font-semibold tracking-tight">Site Inspector</h1>
        <RunnerStatus className="ml-auto" />
        {active.length > 0 && <QueueSheet counts={queued} />}
        <ThemeToggle />
        <Button variant="ghost" size="icon" asChild aria-label="Settings" title="Settings">
          <Link to="/settings">
            <Settings />
          </Link>
        </Button>
      </header>
      <NewCrawlForm />
      <section className="grid gap-3">
        <h2 className="text-lg font-semibold">Crawls</h2>
        <CrawlTable />
      </section>
    </main>
  )
}

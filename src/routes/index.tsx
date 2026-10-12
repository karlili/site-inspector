import { Link, createFileRoute } from '@tanstack/react-router'
import { ScanSearch, Settings } from 'lucide-react'
import { CrawlTable } from '#/components/CrawlTable'
import { NewCrawlForm } from '#/components/NewCrawlForm'
import { RunnerStatus } from '#/components/RunnerStatus'
import { Button } from '#/components/ui/button'
import { crawlsQuery } from '#/lib/queries'

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(crawlsQuery()),
  component: Home,
})

function Home() {
  return (
    <main className="mx-auto grid max-w-5xl gap-8 px-4 py-10">
      <header className="flex items-center gap-3">
        <ScanSearch className="size-7" />
        <h1 className="text-2xl font-semibold tracking-tight">Site Inspector</h1>
        <RunnerStatus className="ml-auto" />
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

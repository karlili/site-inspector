import { Link, createFileRoute } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { RunnerSettingsForm } from '#/components/RunnerSettingsForm'
import { RunnerStatus } from '#/components/RunnerStatus'
import { Button } from '#/components/ui/button'
import { runnerSettingsQuery } from '#/lib/queries'

export const Route = createFileRoute('/settings')({
  loader: ({ context }) => context.queryClient.ensureQueryData(runnerSettingsQuery()),
  head: () => ({ meta: [{ title: 'Settings · Site Inspector' }] }),
  component: SettingsPage,
})

function SettingsPage() {
  return (
    <main className="mx-auto grid max-w-3xl gap-8 px-4 py-10">
      <header className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label="Back">
          <Link to="/">
            <ArrowLeft />
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <RunnerStatus className="ml-auto" />
      </header>
      <RunnerSettingsForm />
    </main>
  )
}

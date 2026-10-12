import { useState } from 'react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import { runnerSettingsQuery } from '#/lib/queries'
import { DEFAULT_RUNNER_SETTINGS, type RunnerSettings } from '#/lib/schemas'
import { saveSettings } from '#/server/functions/settings'

const number = (min: number, max: number, unit: string, int = false) =>
  z
    .string()
    .trim()
    .min(1, 'Required')
    .transform(Number)
    .pipe(
      z
        .number({ error: 'Enter a number' })
        .refine((n) => !int || Number.isInteger(n), 'Enter a whole number')
        .refine((n) => n >= min && n <= max, `Between ${min} and ${max}${unit}`),
    )

// Times are entered in seconds and stored in milliseconds.
const formSchema = z
  .object({
    fetchDelay: number(0, 60, ' s'),
    maxInFlightPerCrawl: number(1, 50, '', true),
    slotsPerRunner: number(1, 32, '', true),
    navTimeout: number(5, 120, ' s'),
    honorCrawlDelay: z.boolean(),
  })
  .transform(
    ({ fetchDelay, navTimeout, ...rest }): RunnerSettings => ({
      ...rest,
      fetchDelayMs: Math.round(fetchDelay * 1000),
      navTimeoutMs: Math.round(navTimeout * 1000),
    }),
  )

type FormValues = z.input<typeof formSchema>

const toForm = (s: RunnerSettings): FormValues => ({
  fetchDelay: String(s.fetchDelayMs / 1000),
  maxInFlightPerCrawl: String(s.maxInFlightPerCrawl),
  slotsPerRunner: String(s.slotsPerRunner),
  navTimeout: String(s.navTimeoutMs / 1000),
  honorCrawlDelay: s.honorCrawlDelay,
})

export function RunnerSettingsForm() {
  const queryClient = useQueryClient()
  const { data: settings } = useSuspenseQuery(runnerSettingsQuery())
  const [values, setValues] = useState(() => toForm(settings))
  const [errors, setErrors] = useState<Record<string, string>>({})

  const mutation = useMutation({
    mutationFn: saveSettings,
    onSuccess: async (saved) => {
      queryClient.setQueryData(runnerSettingsQuery().queryKey, saved)
      setValues(toForm(saved))
      await queryClient.invalidateQueries({ queryKey: ['runners'] })
      toast.success('Settings saved')
    },
    onError: (err) => toast.error(err.message),
  })

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const parsed = formSchema.safeParse(values)
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])),
      )
      return
    }
    setErrors({})
    mutation.mutate({ data: parsed.data })
  }

  const field = (name: Exclude<keyof FormValues, 'honorCrawlDelay'>) => ({
    id: name,
    value: values[name],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setValues((prev) => ({ ...prev, [name]: e.target.value })),
    'aria-invalid': !!errors[name],
    'aria-describedby': `${name}-help`,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>Runners</CardTitle>
        <CardDescription>
          Shared by every runner and picked up without restarting them.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-6">
          <Setting
            name="fetchDelay"
            label="Wait between page loads (seconds)"
            help="Minimum time between starting two page loads on the same site, across all runners. Pages that take longer can still overlap; set max pages in flight to 1 to load one at a time."
            error={errors.fetchDelay}
          >
            <Input type="number" min={0} max={60} step="any" {...field('fetchDelay')} />
          </Setting>

          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={values.honorCrawlDelay}
              onCheckedChange={(c) => setValues((prev) => ({ ...prev, honorCrawlDelay: c === true }))}
            />
            <span className="grid gap-1">
              Honor robots.txt Crawl-delay
              <span className="text-muted-foreground text-xs">
                Wait longer when a site asks for it (up to 60 s). Only crawls that respect
                robots.txt read it.
              </span>
            </span>
          </label>

          <div className="grid gap-6 sm:grid-cols-2">
            <Setting
              name="maxInFlightPerCrawl"
              label="Max pages in flight per crawl"
              help="Pages of one site being captured at once, across all runners."
              error={errors.maxInFlightPerCrawl}
            >
              <Input type="number" min={1} max={50} {...field('maxInFlightPerCrawl')} />
            </Setting>
            <Setting
              name="slotsPerRunner"
              label="Slots per runner"
              help={
                <>
                  Pages each runner captures at once. Applies within ~15 s;{' '}
                  <code className="font-mono">RUNNER_CONCURRENCY</code> overrides it.
                </>
              }
              error={errors.slotsPerRunner}
            >
              <Input type="number" min={1} max={32} {...field('slotsPerRunner')} />
            </Setting>
            <Setting
              name="navTimeout"
              label="Page load timeout (seconds)"
              help="How long each viewport's page load may take before it fails."
              error={errors.navTimeout}
            >
              <Input type="number" min={5} max={120} step="any" {...field('navTimeout')} />
            </Setting>
          </div>

          <div className="flex gap-2">
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Saving…' : 'Save settings'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setValues(toForm(DEFAULT_RUNNER_SETTINGS))
                setErrors({})
              }}
            >
              Restore defaults
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

function Setting({
  name,
  label,
  help,
  error,
  children,
}: {
  name: string
  label: string
  help: React.ReactNode
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid content-start gap-2">
      <Label htmlFor={name}>{label}</Label>
      {children}
      {error && <p className="text-destructive text-sm">{error}</p>}
      <p id={`${name}-help`} className="text-muted-foreground text-xs">
        {help}
      </p>
    </div>
  )
}

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#/components/ui/card'
import { Checkbox } from '#/components/ui/checkbox'
import { Input } from '#/components/ui/input'
import { Label } from '#/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
import { MAX_DEPTH, crawlInputSchema } from '#/lib/schemas'
import { VIEWPORTS, VIEWPORT_IDS, type ViewportId } from '#/lib/viewports'
import { startCrawl } from '#/server/functions/crawls'

export function NewCrawlForm() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [maxDepth, setMaxDepth] = useState('2')
  const [maxPages, setMaxPages] = useState('200')
  const [viewports, setViewports] = useState<ViewportId[]>([...VIEWPORT_IDS])
  const [respectRobots, setRespectRobots] = useState(true)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const mutation = useMutation({
    mutationFn: startCrawl,
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: ['crawls'] })
      navigate({ to: '/crawls/$crawlId', params: { crawlId: id } })
    },
    onError: (err) => toast.error(err.message),
  })

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    // Let people type "example.com" without the scheme.
    const withScheme = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`
    const parsed = crawlInputSchema.safeParse({
      url: withScheme,
      maxDepth,
      maxPages,
      viewports,
      respectRobots,
    })
    if (!parsed.success) {
      setErrors(
        Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message])),
      )
      return
    }
    setErrors({})
    mutation.mutate({ data: parsed.data })
  }

  const toggleViewport = (id: ViewportId, checked: boolean) =>
    setViewports((prev) =>
      checked ? VIEWPORT_IDS.filter((v) => v === id || prev.includes(v)) : prev.filter((v) => v !== id),
    )

  return (
    <Card>
      <CardHeader>
        <CardTitle>Inspect a site</CardTitle>
        <CardDescription>
          Crawls links on the same domain and captures a full-page screenshot of every page.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-5">
          <div className="grid gap-2">
            <Label htmlFor="url">Website URL</Label>
            <Input
              id="url"
              placeholder="https://example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              aria-invalid={!!errors.url}
              autoFocus
            />
            {errors.url && <p className="text-destructive text-sm">{errors.url}</p>}
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="depth">Link depth</Label>
              <Select value={maxDepth} onValueChange={setMaxDepth}>
                <SelectTrigger id="depth" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: MAX_DEPTH + 1 }, (_, d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d === 0 ? '0 — start page only' : `${d} level${d > 1 ? 's' : ''} deep`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="maxPages">Max pages</Label>
              <Input
                id="maxPages"
                type="number"
                min={1}
                max={1000}
                value={maxPages}
                onChange={(e) => setMaxPages(e.target.value)}
                aria-invalid={!!errors.maxPages}
              />
              {errors.maxPages && <p className="text-destructive text-sm">{errors.maxPages}</p>}
            </div>
          </div>

          <fieldset className="grid gap-2">
            <legend className="mb-2 text-sm font-medium">Screen sizes</legend>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {VIEWPORT_IDS.map((id) => (
                <label key={id} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={viewports.includes(id)}
                    onCheckedChange={(c) => toggleViewport(id, c === true)}
                  />
                  {VIEWPORTS[id].label}
                  <span className="text-muted-foreground">
                    {VIEWPORTS[id].width}×{VIEWPORTS[id].height}
                  </span>
                </label>
              ))}
            </div>
            {errors.viewports && <p className="text-destructive text-sm">{errors.viewports}</p>}
          </fieldset>

          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={respectRobots} onCheckedChange={(c) => setRespectRobots(c === true)} />
            Respect robots.txt
          </label>

          <div>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? 'Starting…' : 'Start crawl'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  )
}

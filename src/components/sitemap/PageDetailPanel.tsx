import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CornerUpRight, ExternalLink, Link2Off, RotateCw, Split, X } from 'lucide-react'
import { toast } from 'sonner'
import { StatusBadge } from '#/components/StatusBadge'
import { GoDeeper } from '#/components/sitemap/GoDeeper'
import { Button } from '#/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import type { LinkHealth } from '#/lib/linkHealth'
import { screenshotUrl, type CrawlDetail } from '#/lib/queries'
import { isPageOpen } from '#/lib/schemas'
import type { SlashGroups } from '#/lib/slashVariants'
import { cn } from '#/lib/utils'
import { VIEWPORTS, VIEWPORT_IDS, type ViewportId } from '#/lib/viewports'
import { refetchPage } from '#/server/functions/crawls'
import { pathOf } from './useBoard'

interface Props {
  detail: CrawlDetail
  health: LinkHealth
  groups: SlashGroups<CrawlDetail['pages'][number]>
  /** The board frame shown; for `/a` and `/a/` the panel switches between them. */
  pageId: string
  /** The screen size the board is showing; its tab opens first. */
  viewport: ViewportId
  onPick: (pageId: string) => void
  onClose: () => void
}

/** Docked to the right of the board: one page's full-size screenshots and where it's linked from. */
export function PageDetailPanel({ detail, health, groups, pageId: frameId, viewport, onPick, onClose }: Props) {
  const variants = groups.variants.get(frameId)
  const conflict = groups.conflicts.has(frameId)
  const [variantId, setVariantId] = useState(frameId)
  useEffect(() => setVariantId(frameId), [frameId])
  // Everything below is about the URL picked; link health is the frame's.
  const pageId = variants?.some((p) => p.id === variantId) ? variantId : frameId

  const page = detail.pages.find((p) => p.id === pageId)
  const shots = detail.screenshots
    .filter((s) => s.pageId === pageId)
    .sort((a, b) => VIEWPORT_IDS.indexOf(b.viewport) - VIEWPORT_IDS.indexOf(a.viewport))
  const linksOut = new Set(detail.links.filter((l) => l.fromPageId === pageId && l.toPageId !== pageId).map((l) => l.toPageId)).size
  const referrers = detail.links
    .filter((l) => l.toPageId === pageId && l.fromPageId !== pageId)
    .flatMap((l) => detail.pages.find((p) => p.id === l.fromPageId) ?? [])
  const brokenLinks = (health.brokenOut.get(frameId) ?? []).flatMap((id) => detail.pages.find((p) => p.id === id) ?? [])

  // Follow the board's screen size, but let the tabs switch on their own.
  const [tab, setTab] = useState<ViewportId>(viewport)
  useEffect(() => setTab(viewport), [viewport])
  const shown = shots.some((s) => s.viewport === tab) ? tab : shots[0]?.viewport

  const queryClient = useQueryClient()
  const refetch = useMutation({
    mutationFn: refetchPage,
    onSuccess: ({ queued }) => {
      if (!queued) toast.message('This page is already being captured.')
      return queryClient.invalidateQueries({ queryKey: ['crawls'] })
    },
    onError: (err) => toast.error(err.message),
  })

  if (!page) return null
  const open = isPageOpen(page.status)
  const crawlId = detail.crawl.id
  return (
    <aside className="bg-card flex h-full flex-col" aria-label="Page preview">
      <header className="grid gap-2 border-b p-4">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 font-semibold break-words">{page.title || 'Untitled page'}</h2>
          <Button variant="ghost" size="icon" className="-mt-1 -mr-2 size-7" onClick={onClose} aria-label="Close preview">
            <X />
          </Button>
        </div>
        {variants && (
          <div className="flex w-fit max-w-full border" role="group" aria-label="URL">
            {variants.map((v) => (
              <Button
                key={v.id}
                variant={v.id === pageId ? 'secondary' : 'ghost'}
                size="xs"
                aria-pressed={v.id === pageId}
                onClick={() => setVariantId(v.id)}
                className="min-w-0 font-mono"
                title={v.title ?? v.url}
              >
                <span className="truncate">{pathOf(v.url)}</span>
              </Button>
            ))}
          </div>
        )}
        {variants && conflict && (
          <div className="border-warning text-warning border-l-2 pl-2 text-xs">
            <p className="flex items-center gap-1 font-medium">
              <Split className="size-3.5" />
              These URLs differ only by a trailing slash, but show different pages:
            </p>
            <ul className="mt-1">
              {variants.map((v) => (
                <li key={v.id} className="flex gap-2">
                  <span className="shrink-0 font-mono text-[11px]">{pathOf(v.url)}</span>
                  <span className="text-muted-foreground min-w-0 truncate">
                    {v.title || 'Untitled page'}
                    {v.httpStatus != null && ` · HTTP ${v.httpStatus}`}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground mt-1">Check which one each link on the site is meant to point to.</p>
          </div>
        )}
        <a
          href={page.url}
          target="_blank"
          rel="noreferrer"
          className="text-muted-foreground inline-flex items-center gap-1 text-sm break-all hover:underline"
        >
          {page.url}
          <ExternalLink className="size-3 shrink-0" />
        </a>
        <div className="text-muted-foreground flex flex-wrap items-center gap-3 text-xs">
          <StatusBadge status={page.status} />
          {page.httpStatus && <span>HTTP {page.httpStatus}</span>}
          <span>Depth {page.depth}</span>
          <span>{referrers.length} inbound · {linksOut} outbound links</span>
          <span title="How deep links are followed below this page">
            Links followed to depth {page.expandToDepth ?? detail.crawl.maxDepth}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="xs"
            disabled={open || refetch.isPending}
            onClick={() => refetch.mutate({ data: { crawlId, pageId } })}
            title="Capture this page again and rediscover its links"
          >
            <RotateCw className={cn(open && 'animate-spin')} />
            {open ? 'Capturing…' : 'Refetch'}
          </Button>
          <GoDeeper
            crawlId={crawlId}
            pageId={pageId}
            size="xs"
            disabled={page.status !== 'done' || page.redirectUrl != null}
          />
        </div>
        {page.error && (
          <p className={cn('text-sm', page.status === 'cancelled' ? 'text-muted-foreground' : 'text-destructive')}>
            {page.error}
          </p>
        )}
        {page.redirectUrl && (
          <div className="border-border text-muted-foreground border-l-2 pl-2 text-xs">
            <p className="text-foreground flex items-center gap-1 font-medium">
              <CornerUpRight className="size-3.5" />
              Redirects to another site:
            </p>
            <a
              href={page.redirectUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 break-all hover:underline"
            >
              {page.redirectUrl}
              <ExternalLink className="size-3 shrink-0" />
            </a>
            <p className="mt-1">The screenshots show that page; its links aren't followed.</p>
          </div>
        )}
        {health.orphans.has(frameId) && (
          <p className="border-warning text-warning border-l-2 pl-2 text-xs">
            Orphan: {page.source === 'sitemap' ? 'listed in sitemap.xml, but no' : 'no'} chain of links leads here
            from the start page.
          </p>
        )}
        {brokenLinks.length > 0 && (
          <div className="text-xs">
            <p className="text-destructive-foreground flex items-center gap-1 font-medium">
              <Link2Off className="size-3.5" />
              {brokenLinks.length} broken {brokenLinks.length === 1 ? 'link' : 'links'}
            </p>
            <ul className="mt-1 max-h-32 overflow-y-auto">
              {brokenLinks.map((target) => (
                <li key={target.id}>
                  <button
                    type="button"
                    onClick={() => onPick(target.id)}
                    className="hover:bg-accent flex w-full items-center gap-2 px-1 py-0.5 text-left"
                    title={target.error ?? target.url}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{new URL(target.url).pathname}</span>
                    <span className="text-destructive-foreground shrink-0 text-[11px]">
                      {target.httpStatus ? `HTTP ${target.httpStatus}` : "Didn't load"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {referrers.length > 0 && (
          <details className="text-xs">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer">
              Referenced from {referrers.length} {referrers.length === 1 ? 'page' : 'pages'}
            </summary>
            <ul className="mt-1 max-h-32 overflow-y-auto">
              {referrers.map((ref) => (
                <li key={ref.id}>
                  <button
                    type="button"
                    onClick={() => onPick(ref.id)}
                    className="hover:bg-accent block w-full truncate px-1 py-0.5 text-left font-mono text-[11px]"
                    title={ref.title ?? ref.url}
                  >
                    {new URL(ref.url).pathname}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </header>

      {shown ? (
        <Tabs value={shown} onValueChange={(v) => setTab(v as ViewportId)} className="min-h-0 flex-1 gap-0">
          {shots.length > 1 && (
            <TabsList className="mx-4 mt-3">
              {shots.map((s) => (
                <TabsTrigger key={s.viewport} value={s.viewport}>
                  {VIEWPORTS[s.viewport].label}
                </TabsTrigger>
              ))}
            </TabsList>
          )}
          {shots.map((s) => (
            // Keyed by page so each preview starts at the top instead of the last one's scroll position.
            <TabsContent key={`${pageId}:${s.viewport}`} value={s.viewport} className="min-h-0 overflow-y-auto p-4">
              <p className="text-muted-foreground mb-2 text-xs">
                {VIEWPORTS[s.viewport].label} · {s.width}×{s.height}px ·{' '}
                <a href={screenshotUrl(s.filePath)} target="_blank" rel="noreferrer" className="hover:underline">
                  open full size
                </a>
              </p>
              <img
                key={s.filePath}
                src={screenshotUrl(s.filePath)}
                alt={`${VIEWPORTS[s.viewport].label} screenshot of ${page.url}`}
                className="bg-muted mx-auto border"
                style={{ maxWidth: s.width, width: '100%', aspectRatio: `${s.width} / ${s.height}` }}
              />
            </TabsContent>
          ))}
        </Tabs>
      ) : (
        <p className="text-muted-foreground p-4 text-sm">
          {isPageOpen(page.status) ? 'Capturing screenshots…' : 'No screenshots captured.'}
        </p>
      )}
    </aside>
  )
}

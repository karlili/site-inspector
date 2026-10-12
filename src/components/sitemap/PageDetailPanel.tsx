import { useEffect, useState } from 'react'
import { ExternalLink, X } from 'lucide-react'
import { StatusBadge } from '#/components/StatusBadge'
import { Button } from '#/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { screenshotUrl, type CrawlDetail } from '#/lib/queries'
import { isPageOpen } from '#/lib/schemas'
import { VIEWPORTS, VIEWPORT_IDS, type ViewportId } from '#/lib/viewports'

interface Props {
  detail: CrawlDetail
  pageId: string
  /** The screen size the board is showing; its tab opens first. */
  viewport: ViewportId
  onPick: (pageId: string) => void
  onClose: () => void
}

/** Docked to the right of the board: one page's full-size screenshots and where it's linked from. */
export function PageDetailPanel({ detail, pageId, viewport, onPick, onClose }: Props) {
  const page = detail.pages.find((p) => p.id === pageId)
  const shots = detail.screenshots
    .filter((s) => s.pageId === pageId)
    .sort((a, b) => VIEWPORT_IDS.indexOf(b.viewport) - VIEWPORT_IDS.indexOf(a.viewport))
  const linksOut = new Set(detail.links.filter((l) => l.fromPageId === pageId && l.toPageId !== pageId).map((l) => l.toPageId)).size
  const referrers = detail.links
    .filter((l) => l.toPageId === pageId && l.fromPageId !== pageId)
    .flatMap((l) => detail.pages.find((p) => p.id === l.fromPageId) ?? [])

  // Follow the board's screen size, but let the tabs switch on their own.
  const [tab, setTab] = useState<ViewportId>(viewport)
  useEffect(() => setTab(viewport), [viewport])
  const shown = shots.some((s) => s.viewport === tab) ? tab : shots[0]?.viewport

  if (!page) return null
  return (
    <aside className="bg-card flex h-full flex-col" aria-label="Page preview">
      <header className="grid gap-2 border-b p-4">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 font-semibold break-words">{page.title || 'Untitled page'}</h2>
          <Button variant="ghost" size="icon" className="-mt-1 -mr-2 size-7" onClick={onClose} aria-label="Close preview">
            <X />
          </Button>
        </div>
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
        </div>
        {page.error && <p className="text-destructive text-sm">{page.error}</p>}
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

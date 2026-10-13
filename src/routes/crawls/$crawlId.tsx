import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ReactFlowProvider } from '@xyflow/react'
import { ArrowLeft, LayoutGrid, Network, PanelLeft, Play, RotateCw, Square, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { CrawlName } from '#/components/CrawlName'
import { RunnerStatus } from '#/components/RunnerStatus'
import { StatusBadge } from '#/components/StatusBadge'
import { GoDeeper } from '#/components/sitemap/GoDeeper'
import { LayersPanel } from '#/components/sitemap/LayersPanel'
import { PageDetailPanel } from '#/components/sitemap/PageDetailPanel'
import { SitemapCanvas, type FocusRequest } from '#/components/sitemap/SitemapCanvas'
import { useBoard } from '#/components/sitemap/useBoard'
import { Button } from '#/components/ui/button'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '#/components/ui/resizable'
import { analyzeLinks } from '#/lib/linkHealth'
import { crawlQuery, crawlTitle, isActive } from '#/lib/queries'
import { foldSlashVariants, groupSlashVariants, healthPages } from '#/lib/slashVariants'
import { VIEWPORTS, VIEWPORT_IDS, type ViewportId } from '#/lib/viewports'
import { cancelCrawl, refetchBranch, refetchCrawl, resumeCrawl } from '#/server/functions/crawls'

export const Route = createFileRoute('/crawls/$crawlId')({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(crawlQuery(params.crawlId)),
  head: ({ loaderData }) => ({
    meta: [{ title: loaderData ? `${crawlTitle(loaderData.crawl)} · Site Inspector` : 'Site Inspector' }],
  }),
  component: CrawlPage,
})

function CrawlPage() {
  const { crawlId } = Route.useParams()
  const { data: detail } = useSuspenseQuery(crawlQuery(crawlId))
  const queryClient = useQueryClient()
  const { crawl, pages } = detail

  // Widest captured screen size first; it's the one most pages were designed for.
  const viewports = VIEWPORT_IDS.filter((v) => crawl.viewports.includes(v)).reverse()
  const [viewport, setViewport] = useState<ViewportId>(viewports[0] ?? 'desktop')
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null)
  const [previewPageId, setPreviewPageId] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null)
  const [showLinks, setShowLinks] = useState(false)
  const [showIssues, setShowIssues] = useState(false)
  const [showLayers, setShowLayers] = useState(true)
  const [layoutVersion, setLayoutVersion] = useState(0)
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)

  // The board is laid out to the canvas's shape when it first appears and on
  // Re-layout, not on every resize, so frames don't move under the user.
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [boardAspect, setBoardAspect] = useState(16 / 10)
  // Side panel widths survive closing and reopening them.
  const pagesWidth = useRef(288)
  const previewWidth = useRef(440)
  const measureCanvas = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (rect?.width && rect.height) setBoardAspect(Math.min(3, Math.max(0.5, rect.width / rect.height)))
  }, [])
  const canvasMounted = useCallback(
    (el: HTMLDivElement | null) => {
      canvasRef.current = el
      // After the panel group has sized the canvas.
      requestAnimationFrame(measureCanvas)
    },
    [measureCanvas],
  )

  // `/a` and `/a/` are crawled separately but share a frame on the board.
  const groups = useMemo(() => groupSlashVariants(pages), [pages])
  const view = useMemo(() => ({ ...detail, ...foldSlashVariants(pages, detail.links, groups) }), [detail, pages, groups])
  const groupOf = useCallback((pageId: string) => groups.groupOf.get(pageId) ?? pageId, [groups])

  const board = useBoard(view, viewport, boardAspect)

  const health = useMemo(() => {
    const linkHealth = analyzeLinks(healthPages(view.pages, groups), view.links)
    return { ...linkHealth, issueIds: new Set([...linkHealth.issueIds, ...groups.conflicts]) }
  }, [view, groups])
  const brokenLinkCount = [...health.brokenOut.values()].reduce((n, targets) => n + targets.length, 0)

  // Pages the search and the issues filter leave in view; null when neither is on.
  const matches = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    if (!q && !showIssues) return null
    return new Set(
      board.order.filter((id) => {
        if (showIssues && !health.issueIds.has(id)) return false
        if (!q) return true
        const frame = board.frames.get(id)!
        const titles = (groups.variants.get(id) ?? [frame.page]).map((p) => p.title ?? '')
        return [frame.number, frame.path, ...titles].some((s) => s.toLowerCase().includes(q))
      }),
    )
  }, [board, groups, deferredQuery, showIssues, health])

  const toggleIssues = () => {
    if (!showIssues) setFocusRequest({ pageIds: [...health.issueIds] })
    setShowIssues(!showIssues)
  }

  // Bring search results into view once typing pauses. Keyed on the query, not
  // `matches`, which changes every time a running crawl refreshes the board.
  const matchesRef = useRef(matches)
  matchesRef.current = matches
  useEffect(() => {
    const timer = setTimeout(() => {
      const ids = matchesRef.current
      if (ids?.size) setFocusRequest({ pageIds: [...ids] })
    }, 350)
    return () => clearTimeout(timer)
  }, [deferredQuery])

  const cancel = useMutation({
    mutationFn: cancelCrawl,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['crawls'] }),
    onError: (err) => toast.error(err.message),
  })
  const resume = useMutation({
    mutationFn: resumeCrawl,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['crawls'] }),
    onError: (err) => toast.error(err.message),
  })
  const refetchAll = useMutation({
    mutationFn: refetchCrawl,
    onSuccess: ({ queued }) => {
      if (queued > 0) toast.success(`Refetching ${queued} ${queued === 1 ? 'page' : 'pages'}`)
      return queryClient.invalidateQueries({ queryKey: ['crawls'] })
    },
    onError: (err) => toast.error(err.message),
  })
  const confirmRefetchAll = () => {
    const n = pages.length
    if (!window.confirm(`Capture all ${n} ${n === 1 ? 'page' : 'pages'} again? Current screenshots stay until new ones replace them.`)) return
    refetchAll.mutate({ data: { crawlId } })
  }
  const refetchFrom = useMutation({
    mutationFn: refetchBranch,
    onSuccess: ({ queued }) => {
      if (queued === 0) toast.message('These pages are already being captured.')
      else toast.success(`Refetching ${queued} ${queued === 1 ? 'page' : 'pages'}`)
      return queryClient.invalidateQueries({ queryKey: ['crawls'] })
    },
    onError: (err) => toast.error(err.message),
  })
  // A frame may stand for both `/a` and `/a/`; the branch starts from each of them.
  const refetchFromPage = useCallback(
    (frameId: string) => {
      const pageIds = (groups.variants.get(frameId) ?? [{ id: frameId }]).map((p) => p.id)
      refetchFrom.mutate({ data: { crawlId, pageIds } })
    },
    [groups, crawlId, refetchFrom.mutate],
  )
  const relayout = () => {
    measureCanvas()
    setLayoutVersion((v) => v + 1)
  }

  // Pages are picked by their own id (the preview lists links to either URL); the board knows their group.
  const pickPage = useCallback(
    (id: string) => {
      const pageId = groupOf(id)
      setSelectedPageId(pageId)
      setFocusRequest({ pageId })
    },
    [groupOf],
  )

  // Pointing at a page in the list zooms the board to it and shows it in the preview panel.
  const previewPage = useCallback((pageId: string) => {
    setPreviewPageId(pageId)
    setFocusRequest({ pageId })
  }, [])

  // While the preview panel is open it follows the selection on the board.
  const selectOnBoard = useCallback((pageId: string | null) => {
    setSelectedPageId(pageId)
    if (pageId) setPreviewPageId((open) => open && pageId)
  }, [])

  const previewOpen = !!previewPageId && board.frames.has(previewPageId)

  const done = pages.filter((p) => p.status === 'done' || p.status === 'failed').length
  const failed = pages.filter((p) => p.status === 'failed').length
  const interrupted = pages.filter((p) => p.status === 'cancelled').length
  const root = pages.find((p) => p.depth === 0)
  const active = isActive(crawl.status)
  const canResume = !active && (interrupted > 0 || root?.status === 'failed')

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card px-4 py-2.5">
        <Button variant="ghost" size="icon" asChild aria-label="Back">
          <Link to="/">
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CrawlName crawl={crawl} />
            <StatusBadge status={crawl.status} />
          </div>
          <p className="text-muted-foreground text-xs">
            {crawl.name && (
              <>
                <a
                  href={crawl.rootUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:text-foreground inline-block max-w-80 truncate align-bottom hover:underline"
                >
                  {crawl.rootUrl}
                </a>
                {' · '}
              </>
            )}
            {done}/{pages.length} pages captured
            {failed > 0 && ` · ${failed} failed`}
            {interrupted > 0 && ` · ${interrupted} not captured`}
            {brokenLinkCount > 0 && ` · ${brokenLinkCount} broken ${brokenLinkCount === 1 ? 'link' : 'links'}`}
            {health.orphans.size > 0 && ` · ${health.orphans.size} orphan ${health.orphans.size === 1 ? 'page' : 'pages'}`}
            {groups.conflicts.size > 0 &&
              ` · ${groups.conflicts.size} trailing-slash ${groups.conflicts.size === 1 ? 'mismatch' : 'mismatches'}`}
            {' '}· depth {crawl.maxDepth} ·{' '}
            {crawl.viewports.map((v) => VIEWPORTS[v].label).join(', ')}
            {crawl.error && <span className="text-destructive"> · {crawl.error}</span>}
          </p>
          {active && <RunnerStatus onlyWhenMissing />}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {viewports.length > 1 && (
            <div className="flex border" role="group" aria-label="Screen size">
              {viewports.map((v) => (
                <Button
                  key={v}
                  variant={v === viewport ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={v === viewport}
                  onClick={() => setViewport(v)}
                >
                  {VIEWPORTS[v].label}
                </Button>
              ))}
            </div>
          )}
          <Button
            variant={showLayers ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={showLayers}
            onClick={() => setShowLayers((v) => !v)}
          >
            <PanelLeft />
            Pages
          </Button>
          <Button
            variant={showLinks ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={showLinks}
            title="Links of the selected page, or every link when nothing is selected"
            onClick={() => setShowLinks((v) => !v)}
          >
            <Network />
            {showLinks ? 'Hide' : 'Show'} links
          </Button>
          <Button
            variant={showIssues ? 'secondary' : 'outline'}
            size="sm"
            aria-pressed={showIssues}
            disabled={health.issueIds.size === 0 && !showIssues}
            title="Only pages with broken links, pages they point to, orphan pages, and URLs that show a different page with a trailing slash"
            onClick={toggleIssues}
          >
            <TriangleAlert />
            Issues
            {health.issueIds.size > 0 && <span className="tabular-nums">{health.issueIds.size}</span>}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={relayout}
          >
            <LayoutGrid />
            Re-layout
          </Button>
          {!active && pages.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              disabled={refetchAll.isPending}
              onClick={confirmRefetchAll}
              title="Capture every page again and rediscover the site's links"
            >
              <RotateCw />
              Refetch all
            </Button>
          )}
          {/* Resume comes first: going deeper skips the pages Stop interrupted. */}
          {!active && !canResume && root?.status === 'done' && <GoDeeper crawlId={crawlId} pageId={root.id} />}
          {canResume && (
            <Button
              size="sm"
              disabled={resume.isPending}
              onClick={() => resume.mutate({ data: { crawlId } })}
              title="Capture the pages the crawl didn't get to, keeping the ones it did"
            >
              <Play />
              Resume
            </Button>
          )}
          {active && (
            <Button
              variant="destructive"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({ data: { crawlId } })}
            >
              <Square />
              Stop
            </Button>
          )}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        {pages.length === 0 ? (
          <div className="text-muted-foreground flex flex-1 items-center justify-center text-sm">
            {active ? 'Waiting for the first page…' : 'No pages were captured.'}
          </div>
        ) : (
          <ReactFlowProvider>
            <ResizablePanelGroup>
              {showLayers && (
                <>
                  <ResizablePanel
                    id="pages"
                    className="flex flex-col"
                    defaultSize={pagesWidth.current}
                    minSize={200}
                    maxSize="50%"
                    groupResizeBehavior="preserve-pixel-size"
                    onResize={(size) => (pagesWidth.current = size.inPixels)}
                  >
                    <LayersPanel
                      board={board}
                      links={view.links}
                      health={health}
                      slashConflicts={groups.conflicts}
                      query={query}
                      onQueryChange={setQuery}
                      matches={matches}
                      selectedPageId={selectedPageId}
                      onPick={pickPage}
                      onHover={previewPage}
                      onOpen={setPreviewPageId}
                    />
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                </>
              )}
              <ResizablePanel id="canvas" minSize={320}>
                <div ref={canvasMounted} className="relative h-full">
                  <SitemapCanvas
                    detail={view}
                    board={board}
                    health={health}
                    slashConflicts={groups.conflicts}
                    showLinks={showLinks}
                    layoutVersion={layoutVersion}
                    selectedPageId={selectedPageId}
                    previewPageId={previewOpen ? previewPageId : null}
                    highlightIds={matches}
                    focusRequest={focusRequest}
                    onSelectPage={selectOnBoard}
                    onOpenPage={setPreviewPageId}
                    onRefetchFrom={refetchFromPage}
                  />
                </div>
              </ResizablePanel>
              {previewOpen && (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    id="preview"
                    className="flex flex-col"
                    defaultSize={previewWidth.current}
                    minSize={280}
                    maxSize="60%"
                    groupResizeBehavior="preserve-pixel-size"
                    onResize={(size) => (previewWidth.current = size.inPixels)}
                  >
                    <PageDetailPanel
                      detail={detail}
                      health={health}
                      groups={groups}
                      pageId={previewPageId}
                      viewport={viewport}
                      onPick={pickPage}
                      onClose={() => setPreviewPageId(null)}
                    />
                  </ResizablePanel>
                </>
              )}
            </ResizablePanelGroup>
          </ReactFlowProvider>
        )}
      </div>
    </div>
  )
}

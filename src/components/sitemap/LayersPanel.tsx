import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleAlert,
  CornerDownRight,
  Loader2,
  Search,
} from 'lucide-react'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import type { CrawlDetail } from '#/lib/queries'
import { isPageOpen } from '#/lib/schemas'
import { cn } from '#/lib/utils'
import type { BoardModel } from './useBoard'

/** How long the pointer rests on a row before the board zooms to it. */
const HOVER_DELAY = 150
const INDENT = 14

interface Props {
  board: BoardModel
  links: CrawlDetail['links']
  query: string
  onQueryChange: (query: string) => void
  /** Ids matching `query`, or null when not searching. */
  matches: Set<string> | null
  selectedPageId: string | null
  onPick: (pageId: string) => void
  /** The pointer settled on a page's row (or one of its references). */
  onHover: (pageId: string) => void
  onOpen: (pageId: string) => void
}

type Row =
  | { kind: 'page'; id: string; depth: number }
  | { kind: 'refs-heading'; id: string; depth: number; count: number }
  | { kind: 'ref'; id: string; refId: string; depth: number }

/**
 * Every page as a tree under the page that first linked to it (the same
 * grouping as the board's sections), with the other pages that link to it one
 * click away.
 */
export function LayersPanel({
  board,
  links,
  query,
  onQueryChange,
  matches,
  selectedPageId,
  onPick,
  onHover,
  onOpen,
}: Props) {
  const { roots, childrenOf, parentOf } = useMemo(() => {
    const childrenOf = new Map<string, string[]>()
    const parentOf = new Map<string, string>()
    const roots: string[] = []
    for (const section of board.sections) {
      if (!section.parentPageId) {
        roots.push(...section.pageIds)
        continue
      }
      childrenOf.set(section.parentPageId, section.pageIds)
      for (const id of section.pageIds) parentOf.set(id, section.parentPageId)
    }
    return { roots, childrenOf, parentOf }
  }, [board.sections])

  // Pages that link to each page, in frame order.
  const referrers = useMemo(() => {
    const byTarget = new Map<string, string[]>()
    for (const link of links) {
      if (link.fromPageId === link.toPageId || !board.numbers.has(link.fromPageId)) continue
      byTarget.set(link.toPageId, [...(byTarget.get(link.toPageId) ?? []), link.fromPageId])
    }
    for (const list of byTarget.values()) list.sort((a, b) => board.numbers.get(a)! - board.numbers.get(b)!)
    return byTarget
  }, [links, board.numbers])

  // Start pages are open and every page below them closed, unless everything was
  // expanded; `toggled` holds the pages flipped from that by hand. Pages that
  // arrive while the crawl runs follow the same rule.
  const [allExpanded, setAllExpanded] = useState(false)
  const [toggled, setToggled] = useState<Set<string>>(() => new Set())
  const rootIds = useMemo(() => new Set(roots), [roots])
  const isExpanded = useCallback(
    (id: string) => (allExpanded || rootIds.has(id)) !== toggled.has(id),
    [allExpanded, rootIds, toggled],
  )
  // "Collapse all" goes back to the start: only the start pages open.
  const anyOpenBelowStart = allExpanded || [...toggled].some((id) => !rootIds.has(id))
  const setAll = (expand: boolean) => {
    setAllExpanded(expand)
    setToggled(new Set())
  }
  const [openRefs, setOpenRefs] = useState<Set<string>>(() => new Set())
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set)
    if (!next.delete(id)) next.add(id)
    return next
  }

  // While searching, show the matches along with the pages that lead to them.
  const visible = useMemo(() => {
    if (!matches) return null
    const ids = new Set<string>()
    for (const id of matches) {
      for (let at: string | undefined = id; at && !ids.has(at); at = parentOf.get(at)) ids.add(at)
    }
    return ids
  }, [matches, parentOf])

  const rows = useMemo(() => {
    const rows: Row[] = []
    const walk = (ids: string[], depth: number) => {
      for (const id of ids) {
        if (visible && !visible.has(id)) continue
        rows.push({ kind: 'page', id, depth })
        const refs = referrers.get(id)
        if (refs && openRefs.has(id)) {
          rows.push({ kind: 'refs-heading', id, depth: depth + 1, count: refs.length })
          for (const refId of refs) rows.push({ kind: 'ref', id, refId, depth: depth + 1 })
        }
        const kids = childrenOf.get(id)
        if (kids && (visible || isExpanded(id))) walk(kids, depth + 1)
      }
    }
    walk(roots, 0)
    return rows
  }, [roots, childrenOf, referrers, visible, isExpanded, openRefs])

  // Reveal the selected page (it may be inside a collapsed branch), then scroll to it.
  const rowEls = useRef(new Map<string, HTMLElement>())
  const pendingScroll = useRef<string | null>(null)
  // Only on a new selection, so collapsing afterwards isn't undone.
  const revealed = useRef<string | null>(null)
  useEffect(() => {
    if (selectedPageId === revealed.current) return
    revealed.current = selectedPageId
    if (!selectedPageId) return
    pendingScroll.current = selectedPageId
    const closed: string[] = []
    for (let at = parentOf.get(selectedPageId); at; at = parentOf.get(at)) {
      if (!isExpanded(at)) closed.push(at)
    }
    if (closed.length === 0) return
    setToggled((prev) => {
      const next = new Set(prev)
      for (const id of closed) {
        if (!next.delete(id)) next.add(id)
      }
      return next
    })
  }, [selectedPageId, parentOf, isExpanded])
  useLayoutEffect(() => {
    const id = pendingScroll.current
    const el = id && rowEls.current.get(id)
    if (!el) return
    el.scrollIntoView({ block: 'nearest' })
    pendingScroll.current = null
  })

  // Hover previews wait for the pointer to rest, so sweeping across the list
  // doesn't send the board zooming past every row. Pointer moves (not enters)
  // start the wait, so rows scrolling under a still pointer don't count.
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const hoverTarget = useRef<string | null>(null)
  const hoverProps = (pageId: string) => ({
    onPointerMove: () => {
      if (hoverTarget.current === pageId) return
      hoverTarget.current = pageId
      clearTimeout(hoverTimer.current)
      hoverTimer.current = setTimeout(() => onHover(pageId), HOVER_DELAY)
    },
    onPointerLeave: () => {
      hoverTarget.current = null
      clearTimeout(hoverTimer.current)
    },
  })
  useEffect(() => () => clearTimeout(hoverTimer.current), [])

  return (
    <aside className="bg-card flex h-full flex-col" aria-label="Pages">
      <div className="flex gap-1.5 border-b p-2">
        <div className="relative min-w-0 flex-1">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={`Search ${board.order.length} pages`}
            className="h-8 pl-8 text-sm"
            aria-label="Search pages"
          />
        </div>
        <Button
          variant="outline"
          size="icon-sm"
          onClick={() => setAll(!anyOpenBelowStart)}
          disabled={!!visible}
          title={anyOpenBelowStart ? 'Collapse all' : 'Expand all'}
          aria-label={anyOpenBelowStart ? 'Collapse all' : 'Expand all'}
        >
          {anyOpenBelowStart ? <ChevronsDownUp /> : <ChevronsUpDown />}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1 text-sm" role="tree" aria-label="Pages by the page that first linked to them">
        {rows.length === 0 && (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">No pages match “{query}”.</p>
        )}
        {rows.map((row) => {
          const pad = { paddingLeft: 8 + row.depth * INDENT }

          if (row.kind === 'refs-heading') {
            return (
              <div key={`${row.id}:refs`} className="text-muted-foreground pt-1 pr-3 text-[11px]" style={pad}>
                Referenced from {row.count} {row.count === 1 ? 'page' : 'pages'}
              </div>
            )
          }

          if (row.kind === 'ref') {
            const frame = board.frames.get(row.refId)!
            return (
              <button
                key={`${row.id}:ref:${row.refId}`}
                type="button"
                onClick={() => onPick(row.refId)}
                onDoubleClick={() => onOpen(row.refId)}
                onFocus={() => onHover(row.refId)}
                {...hoverProps(row.refId)}
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-1.5 py-0.5 pr-3 text-left text-xs"
                style={pad}
                title={`${frame.page.title || frame.path}\n${frame.path} links here`}
              >
                <CornerDownRight className="size-3 shrink-0" />
                <span className="w-7 shrink-0 tabular-nums">{frame.number}</span>
                <span className="min-w-0 truncate font-mono text-[11px]">{frame.path}</span>
              </button>
            )
          }

          const { id } = row
          const frame = board.frames.get(id)!
          const { page } = frame
          const selected = id === selectedPageId
          const kids = childrenOf.get(id)
          const expanded = kids ? !!visible || isExpanded(id) : undefined
          const refCount = referrers.get(id)?.length ?? 0
          const dimmed = matches && !matches.has(id)
          return (
            <div
              key={id}
              ref={(el) => {
                if (el) rowEls.current.set(id, el)
                else rowEls.current.delete(id)
              }}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-expanded={expanded}
              aria-selected={selected}
              className={cn(
                'group/row hover:bg-accent flex items-start pr-3',
                selected && 'bg-frame-selected/15 hover:bg-frame-selected/20',
              )}
              style={pad}
              {...hoverProps(id)}
            >
              {kids ? (
                <button
                  type="button"
                  onClick={() => setToggled((prev) => toggle(prev, id))}
                  disabled={!!visible}
                  className="text-muted-foreground hover:text-foreground mt-1 flex size-4 shrink-0 items-center justify-center disabled:opacity-50"
                  aria-label={`${expanded ? 'Collapse' : 'Expand'} ${kids.length} linked pages`}
                >
                  <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
                </button>
              ) : (
                <span className="size-4 shrink-0" />
              )}
              <button
                type="button"
                onClick={() => onPick(id)}
                onDoubleClick={() => onOpen(id)}
                onFocus={() => onHover(id)}
                className={cn('flex min-w-0 flex-1 items-start gap-2 py-1 pl-1 text-left', dimmed && 'opacity-50')}
                aria-current={selected || undefined}
              >
                <span className="text-muted-foreground w-7 shrink-0 pt-px text-xs tabular-nums">{frame.number}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{page.title || frame.path}</span>
                  <span className="text-muted-foreground block truncate font-mono text-[11px]">{frame.path}</span>
                </span>
                {isPageOpen(page.status) && (
                  <Loader2 className="text-muted-foreground mt-[3px] size-3.5 shrink-0 animate-spin" aria-label="Loading" />
                )}
                {page.status === 'failed' && (
                  <CircleAlert className="text-destructive-foreground mt-[3px] size-3.5 shrink-0" aria-label="Failed" />
                )}
                {page.httpStatus != null && page.httpStatus >= 400 && (
                  <span className="bg-destructive mt-0.5 shrink-0 px-1 text-[10px] text-white">{page.httpStatus}</span>
                )}
              </button>
              {refCount > 0 && (
                <button
                  type="button"
                  onClick={() => setOpenRefs((prev) => toggle(prev, id))}
                  className={cn(
                    'text-muted-foreground hover:text-foreground mt-0.5 ml-2 shrink-0 border px-1 text-[10px] tabular-nums',
                    openRefs.has(id) ? 'border-border bg-background' : 'border-transparent',
                  )}
                  aria-expanded={openRefs.has(id)}
                  title={`Referenced from ${refCount} ${refCount === 1 ? 'page' : 'pages'}`}
                  aria-label={`Show the ${refCount} ${refCount === 1 ? 'page' : 'pages'} linking here`}
                >
                  ←{refCount}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

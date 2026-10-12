import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import {
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  getNodesBounds,
  useNodesState,
  useReactFlow,
  useStore,
  type Edge,
  type Node,
  type NodeChange,
  type OnNodeDrag,
  type Rect,
} from '@xyflow/react'
import { useMutation } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { CrawlDetail } from '#/lib/queries'
import { cn } from '#/lib/utils'
import { saveNodePositions } from '#/server/functions/crawls'
import { sectionBounds } from './layout'
import { BoardActionsContext, PageNode, type PageNodeType } from './PageNode'
import { SectionNode, type SectionNodeType } from './SectionNode'
import type { BoardModel } from './useBoard'

const nodeTypes = { page: PageNode, section: SectionNode }
const SECTION_PREFIX = 'section:'
/** Labels keep a constant on-screen size until they'd outgrow the gap they sit in. */
const LABEL_MAX_SCALE = 4
const TITLE_MAX_SCALE = 9
/** Below this zoom frame names are too small to read, so they're hidden. */
const LABEL_MIN_ZOOM = 0.14
/** From this zoom on frames load their full-size preview instead of the small one. */
const FULL_PREVIEW_ZOOM = 0.3
/** Gap kept between a section title and the next section's title. */
const TITLE_GAP = 48

export type FocusRequest = { pageId: string } | { pageIds: string[] } | { sectionId: string }

interface Props {
  detail: CrawlDetail
  board: BoardModel
  showLinks: boolean
  /** Bumped by the parent to discard local positions and re-run the auto layout. */
  layoutVersion: number
  selectedPageId: string | null
  /** The page shown in the preview panel; its frame is outlined. */
  previewPageId: string | null
  /** Pages matching the current search; everything else is dimmed. Null when not searching. */
  highlightIds: Set<string> | null
  /** Changes whenever the parent wants a page or section brought into view. */
  focusRequest: FocusRequest | null
  onSelectPage: (pageId: string | null) => void
  onOpenPage: (pageId: string) => void
}

export function SitemapCanvas({
  detail,
  board,
  showLinks,
  layoutVersion,
  selectedPageId,
  previewPageId,
  highlightIds,
  focusRequest,
  onSelectPage,
  onOpenPage,
}: Props) {
  const { crawl, links } = detail
  const [frames, setFrames, onFramesChange] = useNodesState<PageNodeType>([])
  // Positions the user dragged this session; they win over the auto layout.
  const localPositions = useRef(new Map<string, { x: number; y: number }>())
  // Keep the whole board in view as pages stream in, until the user pans or zooms.
  const userMovedViewport = useRef(false)
  // What the board last zoomed to, kept centred while the side panels resize it.
  const lastFocus = useRef<FocusRequest | null>(null)
  const { fitView } = useReactFlow()

  useEffect(() => {
    localPositions.current.clear()
    userMovedViewport.current = false
    lastFocus.current = null
  }, [layoutVersion])

  // Frame sizes change with the viewport, so start from a full view again.
  const frameWidth = board.frames.values().next().value?.width
  useEffect(() => {
    userMovedViewport.current = false
    lastFocus.current = null
  }, [frameWidth])

  useEffect(() => {
    setFrames(
      board.order.map((id) => {
        const frame = board.frames.get(id)!
        const { page } = frame
        const stored = page.posX != null && page.posY != null ? { x: page.posX, y: page.posY } : null
        return {
          id,
          type: 'page',
          position: localPositions.current.get(id) ?? stored ?? board.positions.get(id)!,
          // Sizes are known up front; setting `measured` too lets fitView run without
          // waiting for React Flow to measure frames that aren't rendered.
          width: frame.width,
          height: frame.height,
          measured: { width: frame.width, height: frame.height },
          data: {
            number: frame.number,
            path: frame.path,
            title: page.title,
            status: page.status,
            httpStatus: page.httpStatus,
            error: page.error,
            preview: frame.preview,
            cropped: frame.cropped,
          },
        }
      }),
    )
  }, [board, setFrames, layoutVersion])

  // Selection, preview and search dimming only touch the frames whose state changed.
  useEffect(() => {
    setFrames((prev) =>
      prev.map((node) => {
        const selected = node.id === selectedPageId
        const className =
          cn(highlightIds && !highlightIds.has(node.id) && 'frame-dimmed', node.id === previewPageId && 'frame-previewed') ||
          undefined
        return node.selected === selected && node.className === className
          ? node
          : { ...node, selected, className }
      }),
    )
    // board/layoutVersion: the frames were just rebuilt without selection state.
  }, [board, layoutVersion, selectedPageId, previewPageId, highlightIds, setFrames])

  const sections = useMemo<SectionNodeType[]>(() => {
    const byId = new Map(frames.map((f) => [f.id, f]))
    const boxes = board.sectionInfo.flatMap((section) => {
      const rects = section.pageIds.flatMap((id) => {
        const node = byId.get(id)
        return node ? [{ ...node.position, width: node.width!, height: node.height! }] : []
      })
      return rects.length ? [{ section, box: sectionBounds(rects) }] : []
    })

    // Titles may run past a narrow section, up to the next title on the same shelf.
    const shelves = new Map<number, number[]>()
    for (const { box } of boxes) shelves.set(box.y, [...(shelves.get(box.y) ?? []), box.x])
    const titleRoom = (box: { x: number; y: number }) => {
      const next = Math.min(...shelves.get(box.y)!.filter((x) => x > box.x))
      return Number.isFinite(next) ? next - box.x - TITLE_GAP : null
    }

    return boxes.map(({ section, box }) => ({
      id: SECTION_PREFIX + section.id,
      type: 'section' as const,
      position: { x: box.x, y: box.y },
      width: box.width,
      height: box.height,
      measured: { width: box.width, height: box.height },
      draggable: false,
      selectable: false,
      focusable: false,
      data: {
        sectionId: section.id,
        title: section.title,
        count: section.pageIds.length,
        titleRoom: titleRoom(box),
      },
    }))
  }, [board, frames])

  // Sections first so frames paint on top of them.
  const nodes = useMemo<Node[]>(() => [...sections, ...frames], [sections, frames])
  const bounds = useMemo(() => getNodesBounds(sections), [sections])

  const onNodesChange = useCallback(
    (changes: NodeChange<Node>[]) =>
      onFramesChange(
        changes.filter(
          (c) => !('id' in c) || !c.id.startsWith(SECTION_PREFIX),
        ) as NodeChange<PageNodeType>[],
      ),
    [onFramesChange],
  )

  useEffect(() => {
    if (userMovedViewport.current) return
    // Wait a frame so React Flow has the new nodes.
    const frame = requestAnimationFrame(() => fitView({ padding: 0.06, maxZoom: 1, duration: 200 }))
    return () => cancelAnimationFrame(frame)
  }, [board, layoutVersion, fitView])

  const fitTo = useCallback(
    (request: FocusRequest, duration: number) => {
      if ('pageId' in request) {
        fitView({ nodes: [{ id: request.pageId }], padding: 0.3, maxZoom: 0.6, duration })
      } else if ('pageIds' in request) {
        fitView({ nodes: request.pageIds.map((id) => ({ id })), padding: 0.15, maxZoom: 0.6, duration })
      } else {
        fitView({ nodes: [{ id: SECTION_PREFIX + request.sectionId }], padding: 0.06, maxZoom: 1, duration })
      }
    },
    [fitView],
  )

  const focus = useCallback(
    (request: FocusRequest) => {
      userMovedViewport.current = true
      lastFocus.current = request
      fitTo(request, 400)
    },
    [fitTo],
  )

  useEffect(() => {
    if (focusRequest) focus(focusRequest)
  }, [focusRequest, focus])

  // Opening, closing or dragging a side panel changes the canvas size: keep
  // whatever the board was zoomed to in view, unless the user has moved since.
  const paneWidth = useStore((s) => s.width)
  const paneHeight = useStore((s) => s.height)
  useEffect(() => {
    if (!paneWidth || !paneHeight) return
    if (lastFocus.current) fitTo(lastFocus.current, 150)
    else if (!userMovedViewport.current) fitView({ padding: 0.06, maxZoom: 1 })
  }, [paneWidth, paneHeight, fitTo, fitView])

  const edges = useMemo<Edge[]>(() => {
    if (!showLinks) return []
    const byId = new Map(frames.map((f) => [f.id, f]))
    const shown = links.filter(
      (l) =>
        l.fromPageId !== l.toPageId &&
        (!selectedPageId || l.fromPageId === selectedPageId || l.toPageId === selectedPageId),
    )
    return shown.flatMap((link) => {
      const from = byId.get(link.fromPageId)
      const to = byId.get(link.toPageId)
      if (!from || !to) return []
      const [sourceSide, targetSide] = facingSides(from, to)
      const outgoing = link.fromPageId === selectedPageId
      return [
        {
          id: `${link.fromPageId}>${link.toPageId}`,
          source: link.fromPageId,
          target: link.toPageId,
          sourceHandle: `s-${sourceSide}`,
          targetHandle: `t-${targetSide}`,
          selectable: false,
          focusable: false,
          // Over the frames, or they'd hide most of every link.
          zIndex: 2000,
          className: selectedPageId ? (outgoing ? 'link-out' : 'link-in') : 'link-all',
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 16,
            height: 16,
            color: outgoing ? 'var(--frame-selected)' : 'var(--muted-foreground)',
          },
        },
      ]
    })
  }, [frames, links, showLinks, selectedPageId])

  const save = useMutation({
    mutationFn: saveNodePositions,
    onError: (err) => toast.error(`Couldn't save layout: ${err.message}`),
  })

  const onNodeDragStop: OnNodeDrag<Node> = useCallback(
    (_event, _node, dragged) => {
      const moved = dragged.filter((n) => n.type === 'page')
      if (!moved.length) return
      for (const n of moved) localPositions.current.set(n.id, n.position)
      save.mutate({
        data: {
          crawlId: crawl.id,
          positions: moved.map((n) => ({ pageId: n.id, x: n.position.x, y: n.position.y })),
        },
      })
    },
    [crawl.id, save],
  )

  const actions = useMemo(
    () => ({ openPage: onOpenPage, focusSection: (sectionId: string) => focus({ sectionId }) }),
    [onOpenPage, focus],
  )

  return (
    <BoardActionsContext.Provider value={actions}>
      <ReactFlow
        className="sitemap-board"
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={(_e, node) => onSelectPage(node.type === 'page' ? node.id : null)}
        onNodeDoubleClick={(_e, node) => node.type === 'page' && onOpenPage(node.id)}
        onPaneClick={() => onSelectPage(null)}
        onMoveStart={(event) => {
          // Programmatic fitView calls have no event.
          if (event) {
            userMovedViewport.current = true
            lastFocus.current = null
          }
        }}
        // Selection is owned by the parent (it's shared with the page list).
        elementsSelectable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomOnDoubleClick={false}
        onlyRenderVisibleElements
        minZoom={0.02}
        maxZoom={2}
        fitView
        fitViewOptions={{ padding: 0.08, maxZoom: 1 }}
      >
        <ZoomScale />
        <Controls showInteractive={false} />
        <OverviewMap bounds={bounds} selectedPageId={selectedPageId} />
      </ReactFlow>
    </BoardActionsContext.Provider>
  )
}

/** The minimap only shows up once part of the board is off-screen; at zoom-to-fit it would just cover frames. */
function OverviewMap({ bounds, selectedPageId }: { bounds: Rect; selectedPageId: string | null }) {
  const offScreen = useStore((s) => {
    const [tx, ty, zoom] = s.transform
    const left = -tx / zoom
    const top = -ty / zoom
    const slack = 2 / zoom
    return (
      bounds.x < left - slack ||
      bounds.y < top - slack ||
      bounds.x + bounds.width > left + s.width / zoom + slack ||
      bounds.y + bounds.height > top + s.height / zoom + slack
    )
  })
  if (!offScreen) return null
  return (
    <MiniMap
      pannable
      zoomable
      style={{ width: 160, height: 110 }}
      nodeColor={(n) =>
        n.type === 'section'
          ? 'var(--minimap-section)'
          : n.id === selectedPageId
            ? 'var(--frame-selected)'
            : 'var(--minimap-frame)'
      }
      nodeStrokeWidth={0}
      nodeBorderRadius={0}
      maskColor="var(--minimap-mask)"
    />
  )
}

/**
 * Publishes the zoom as CSS variables so frame names and section titles can
 * counter-scale to a constant on-screen size without re-rendering any node.
 */
function ZoomScale() {
  const zoom = useStore((s) => s.transform[2])
  const domNode = useStore((s) => s.domNode)
  useLayoutEffect(() => {
    if (!domNode) return
    domNode.style.setProperty('--zoom', String(zoom))
    domNode.style.setProperty('--label-scale', String(Math.min(1 / zoom, LABEL_MAX_SCALE)))
    domNode.style.setProperty('--title-scale', String(Math.min(1 / zoom, TITLE_MAX_SCALE)))
    domNode.style.setProperty('--label-opacity', zoom < LABEL_MIN_ZOOM ? '0' : '1')
    // Lazy images that aren't displayed are never fetched, so the overview stays light.
    domNode.style.setProperty('--full-preview-display', zoom < FULL_PREVIEW_ZOOM ? 'none' : 'block')
  }, [zoom, domNode])
  return null
}

type Side = 'top' | 'right' | 'bottom' | 'left'

/** Attach a link to the sides of the two frames that face each other. */
function facingSides(from: PageNodeType, to: PageNodeType): [Side, Side] {
  const dx = to.position.x + to.width! / 2 - (from.position.x + from.width! / 2)
  const dy = to.position.y + to.height! / 2 - (from.position.y + from.height! / 2)
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? ['right', 'left'] : ['left', 'right']
  return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom']
}

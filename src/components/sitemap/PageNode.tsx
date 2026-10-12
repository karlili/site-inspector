import { Fragment, createContext, memo, useContext } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { ImageOff, Loader2, Maximize2 } from 'lucide-react'
import { cn } from '#/lib/utils'
import { isPageOpen, type PageStatus } from '#/lib/schemas'

export type PageNodeData = {
  number: string
  path: string
  title: string | null
  status: PageStatus
  httpStatus: number | null
  error: string | null
  preview: { full: string; small: string } | null
  cropped: boolean
}

export type PageNodeType = Node<PageNodeData, 'page'>

/** Lets frames and sections act on the board without threading callbacks through node data. */
export const BoardActionsContext = createContext<{
  openPage: (pageId: string) => void
  focusSection: (sectionId: string) => void
}>({ openPage: () => {}, focusSection: () => {} })

/** Keeps the last path segment readable by shortening the folders before it first. */
function FramePath({ path }: { path: string }) {
  const cut = path.replace(/\/$/, '').lastIndexOf('/')
  if (cut <= 0) return <span className="min-w-0 truncate">{path}</span>
  return (
    <span className="flex min-w-0">
      <span className="min-w-0 truncate">{path.slice(0, cut + 1)}</span>
      <span className="max-w-full shrink-0 truncate">{path.slice(cut + 1)}</span>
    </span>
  )
}

const SIDES = [
  ['top', Position.Top],
  ['right', Position.Right],
  ['bottom', Position.Bottom],
  ['left', Position.Left],
] as const

export const PageNode = memo(function PageNode({ id, data, selected }: NodeProps<PageNodeType>) {
  const { openPage } = useContext(BoardActionsContext)
  const failed = data.status === 'failed'
  const badStatus = data.httpStatus != null && data.httpStatus >= 400

  return (
    <div className="group relative h-full w-full">
      {/* Figma-style frame name: stays the same size on screen at any zoom. */}
      <div
        className={cn(
          'frame-label text-muted-foreground flex items-center gap-1.5 pb-1.5 text-[11px] leading-4',
          selected && 'text-frame-selected',
          failed && 'text-destructive-foreground',
        )}
        title={data.title ? `${data.title}\n${data.path}` : data.path}
      >
        <span className="shrink-0 font-medium tabular-nums">{data.number}</span>
        <FramePath path={data.path} />
        {badStatus && <span className="bg-destructive shrink-0 px-1 text-[10px] text-white">{data.httpStatus}</span>}
        <button
          type="button"
          className={cn(
            'nodrag nopan hover:text-foreground ml-auto hidden shrink-0 p-0.5 group-hover:block',
            selected && 'block',
          )}
          onClick={(event) => {
            event.stopPropagation()
            openPage(id)
          }}
          aria-label={`View screenshots of ${data.path}`}
          title="View screenshots"
        >
          <Maximize2 className="size-3" />
        </button>
      </div>

      <div
        className={cn(
          'page-frame bg-card relative h-full w-full overflow-hidden',
          selected && 'page-frame-selected',
          failed && 'page-frame-failed',
        )}
      >
        {data.preview ? (
          <>
            <img
              src={data.preview.small}
              alt=""
              draggable={false}
              loading="lazy"
              decoding="async"
              // Previews are cut to the frame's shape, so they fill it exactly.
              className="absolute inset-0 size-full object-cover object-top select-none"
            />
            <img
              src={data.preview.full}
              alt=""
              draggable={false}
              loading="lazy"
              decoding="async"
              className="frame-full-preview absolute inset-0 size-full object-cover object-top select-none"
            />
          </>
        ) : (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-xs">
            {isPageOpen(data.status) ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <>
                <ImageOff className="size-5" />
                <span className="line-clamp-3">{data.error ?? 'No screenshot'}</span>
              </>
            )}
          </div>
        )}
        {data.cropped && (
          // The page keeps going below the frame; fade it out rather than cut it hard.
          <div className="from-card pointer-events-none absolute inset-x-0 bottom-0 h-20 bg-linear-to-t to-transparent" />
        )}
      </div>

      {SIDES.map(([side, position]) => (
        <Fragment key={side}>
          <Handle id={`s-${side}`} type="source" position={position} className="frame-handle" isConnectable={false} />
          <Handle id={`t-${side}`} type="target" position={position} className="frame-handle" isConnectable={false} />
        </Fragment>
      ))}
    </div>
  )
})

import { memo, useContext } from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import { RotateCw } from 'lucide-react'
import { cn } from '#/lib/utils'
import { SECTION_TITLE_SPACE } from './layout'
import { BoardActionsContext } from './PageNode'

export type SectionNodeData = {
  sectionId: string
  title: string
  count: number
  /** Board units free to the right before the next section's title; null if unlimited. */
  titleRoom: number | null
  /** The page whose links fill the section; null for the start and sitemap sections. */
  parentPageId: string | null
  /** That page is waiting to be captured or being captured. */
  parentOpen: boolean
}

export type SectionNodeType = Node<SectionNodeData, 'section'>

/** Backdrop grouping the pages one page links to, with its title above the box. */
export const SectionNode = memo(function SectionNode({ data }: NodeProps<SectionNodeType>) {
  const { focusSection, refetchFrom } = useContext(BoardActionsContext)
  const { parentPageId, parentOpen } = data
  return (
    <div className="pointer-events-none relative h-full w-full">
      <div
        className="section-title flex items-baseline gap-2 pb-3 text-sm leading-5"
        style={{
          bottom: `calc(100% - ${SECTION_TITLE_SPACE}px)`,
          maxWidth: data.titleRoom == null ? undefined : `calc(${data.titleRoom}px / var(--title-scale))`,
        }}
      >
        <button
          type="button"
          className="hover:text-frame-selected pointer-events-auto flex min-w-0 items-baseline gap-2 text-left"
          onClick={(event) => {
            event.stopPropagation()
            focusSection(data.sectionId)
          }}
          title={`${data.title} — zoom to section`}
        >
          <span className="max-w-full shrink-0 truncate font-semibold">{data.title}</span>
          {/* When space is short the count gives way before the title does. */}
          <span className="text-muted-foreground min-w-0 overflow-hidden text-xs tabular-nums">
            {data.count} {data.count === 1 ? 'page' : 'pages'}
          </span>
        </button>
        {parentPageId && (
          <button
            type="button"
            className="text-muted-foreground hover:text-frame-selected pointer-events-auto flex shrink-0 items-center gap-1 self-center text-xs disabled:pointer-events-none disabled:opacity-60"
            disabled={parentOpen}
            onClick={(event) => {
              event.stopPropagation()
              refetchFrom(parentPageId)
            }}
            title={`Capture ${data.title} and every page filed under it again`}
          >
            <RotateCw className={cn('size-3', parentOpen && 'animate-spin')} />
            {parentOpen ? 'Capturing…' : 'Re-fetch from'}
          </button>
        )}
      </div>
      <div className="section-box absolute inset-x-0 bottom-0" style={{ top: SECTION_TITLE_SPACE }} />
    </div>
  )
})

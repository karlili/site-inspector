/*
 * Figma-style board: every page is a frame, grouped into sections by the page
 * that first linked to it. Sections are numbered and laid out breadth-first,
 * frames wrap into rows inside their section, and sections wrap into shelves
 * so the whole board comes out roughly screen-shaped.
 *
 * All sizes are board units (canvas pixels at 100% zoom).
 */

/** Space above each frame for its name. */
export const FRAME_LABEL_SPACE = 96
const COLUMN_GAP = 56
const ROW_GAP = FRAME_LABEL_SPACE + 32
const SECTION_PAD_X = 64
const SECTION_PAD_TOP = FRAME_LABEL_SPACE + 40
const SECTION_PAD_BOTTOM = 64
/** Space above each section box for its title. */
export const SECTION_TITLE_SPACE = 300
const SECTION_GAP_X = 160
const SECTION_GAP_Y = 120
const MAX_COLUMNS = 40

export const ROOT_SECTION = '__root__'
/** Pages listed in sitemap.xml that nothing links to; they come last. */
export const SITEMAP_SECTION = '__sitemap__'

export interface BoardPage {
  id: string
  parentPageId: string | null
  source?: 'link' | 'sitemap'
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface BoardSection {
  id: string
  /** The page whose links this section holds; null for the start page(s). */
  parentPageId: string | null
  pageIds: string[]
}

export interface Board {
  /** Page ids in frame-number order (frame n is `order[n - 1]`). */
  order: string[]
  numbers: Map<string, number>
  sections: BoardSection[]
  sectionOf: Map<string, string>
  /** Auto-layout top-left corner of each frame. */
  positions: Map<string, { x: number; y: number }>
}

/**
 * `pages` must be in discovery order (depth, then crawl order); `sizes` gives
 * each frame's width and height. Pages missing from `sizes` get a zero-height
 * frame. `targetAspect` is the width:height the board aims for, normally the
 * canvas's own, so zoom-to-fit uses the whole screen.
 */
export function layoutBoard(
  pages: BoardPage[],
  sizes: Map<string, { width: number; height: number }>,
  targetAspect = 16 / 10,
): Board {
  const { order, sections } = groupIntoSections(pages)
  const numbers = new Map(order.map((id, i) => [id, i + 1]))
  const sectionOf = new Map<string, string>()
  for (const section of sections) for (const id of section.pageIds) sectionOf.set(id, section.id)

  const sizeOf = (id: string) => sizes.get(id) ?? { width: 0, height: 0 }
  const largest = Math.max(0, ...sections.map((s) => s.pageIds.length))

  // Try every column count and keep the board closest to the target shape.
  let best: { positions: Map<string, { x: number; y: number }>; score: number } | null = null
  for (let columns = 1; columns <= Math.max(1, Math.min(MAX_COLUMNS, Math.max(largest, pages.length))); columns++) {
    const { positions, width, height } = packSections(sections, sizeOf, columns)
    const score = Math.abs(Math.log(width / Math.max(height, 1) / targetAspect))
    if (!best || score < best.score - 1e-9) best = { positions, score }
  }

  return { order, numbers, sections, sectionOf, positions: best?.positions ?? new Map() }
}

/** Breadth-first: start page(s) first, then a section per page that discovered others. */
function groupIntoSections(pages: BoardPage[]) {
  const ids = new Set(pages.map((p) => p.id))
  const children = new Map<string, string[]>()
  const roots: string[] = []
  const unlinked: string[] = []
  for (const page of pages) {
    if (page.source === 'sitemap') {
      unlinked.push(page.id)
    } else if (page.parentPageId && page.parentPageId !== page.id && ids.has(page.parentPageId)) {
      const list = children.get(page.parentPageId) ?? []
      list.push(page.id)
      children.set(page.parentPageId, list)
    } else {
      roots.push(page.id)
    }
  }

  const sections: BoardSection[] = []
  if (roots.length) sections.push({ id: ROOT_SECTION, parentPageId: null, pageIds: roots })
  const order = [...roots]
  for (let i = 0; i < order.length; i++) {
    const kids = children.get(order[i])
    if (!kids) continue
    sections.push({ id: order[i], parentPageId: order[i], pageIds: kids })
    order.push(...kids)
  }
  if (unlinked.length) {
    sections.push({ id: SITEMAP_SECTION, parentPageId: null, pageIds: unlinked })
    order.push(...unlinked)
  }

  // Parent links can't loop in practice, but never drop a page if they do.
  const placed = new Set(order)
  const stray = pages.filter((p) => !placed.has(p.id)).map((p) => p.id)
  if (stray.length) {
    sections.push({ id: '__unlinked__', parentPageId: null, pageIds: stray })
    order.push(...stray)
  }
  return { order, sections }
}

/** Frames wrap at `columns` inside each section; sections wrap into shelves of the same width. */
function packSections(
  sections: BoardSection[],
  sizeOf: (id: string) => { width: number; height: number },
  columns: number,
) {
  const positions = new Map<string, { x: number; y: number }>()
  const cellWidth = Math.max(0, ...sections.flatMap((s) => s.pageIds.map((id) => sizeOf(id).width)))
  const shelfWidth = 2 * SECTION_PAD_X + columns * cellWidth + (columns - 1) * COLUMN_GAP

  let x = 0
  let y = 0
  let shelfHeight = 0
  let boardWidth = 0

  for (const section of sections) {
    // Lay frames out relative to the section's top-left corner (title space included).
    const local: { id: string; x: number; y: number }[] = []
    const sectionColumns = Math.min(columns, section.pageIds.length)
    let rowTop = SECTION_TITLE_SPACE + SECTION_PAD_TOP
    for (let start = 0; start < section.pageIds.length; start += sectionColumns) {
      const row = section.pageIds.slice(start, start + sectionColumns)
      row.forEach((id, col) => {
        local.push({ id, x: SECTION_PAD_X + col * (cellWidth + COLUMN_GAP), y: rowTop })
      })
      rowTop += Math.max(...row.map((id) => sizeOf(id).height)) + ROW_GAP
    }
    const width = 2 * SECTION_PAD_X + sectionColumns * cellWidth + (sectionColumns - 1) * COLUMN_GAP
    const height = rowTop - ROW_GAP + SECTION_PAD_BOTTOM

    if (x > 0 && x + width > shelfWidth) {
      y += shelfHeight + SECTION_GAP_Y
      x = 0
      shelfHeight = 0
    }
    for (const frame of local) positions.set(frame.id, { x: x + frame.x, y: y + frame.y })
    boardWidth = Math.max(boardWidth, x + width)
    shelfHeight = Math.max(shelfHeight, height)
    x += width + SECTION_GAP_X
  }

  return { positions, width: boardWidth, height: y + shelfHeight }
}

/**
 * The section box (title space included) around a set of frames. Used for
 * both the auto layout and frames the user has dragged somewhere else.
 */
export function sectionBounds(frames: Rect[]): Rect {
  const left = Math.min(...frames.map((f) => f.x))
  const top = Math.min(...frames.map((f) => f.y))
  const right = Math.max(...frames.map((f) => f.x + f.width))
  const bottom = Math.max(...frames.map((f) => f.y + f.height))
  return {
    x: left - SECTION_PAD_X,
    y: top - SECTION_PAD_TOP - SECTION_TITLE_SPACE,
    width: right - left + 2 * SECTION_PAD_X,
    height: bottom - top + SECTION_PAD_TOP + SECTION_PAD_BOTTOM + SECTION_TITLE_SPACE,
  }
}

/** Space between the focused frame and the columns either side, so the links have room. */
const LINK_GAP = 6 * COLUMN_GAP

/**
 * One page's links: the page stays at `anchor`, pages linking to it stack in
 * columns on its left and pages it links to on its right. Columns fill
 * top-down, nearest the page first, and the row count is chosen so the whole
 * group comes out roughly `targetAspect`-shaped. `bounds` includes the frames'
 * label space.
 */
export function layoutLinkFocus(
  centerId: string,
  incoming: string[],
  outgoing: string[],
  sizeOf: (id: string) => { width: number; height: number },
  anchor: { x: number; y: number },
  targetAspect = 16 / 10,
): { positions: Map<string, { x: number; y: number }>; bounds: Rect } {
  const center = sizeOf(centerId)
  const cellWidth = Math.max(0, ...[...incoming, ...outgoing].map((id) => sizeOf(id).width))
  const middle = anchor.y + center.height / 2

  const placeSide = (ids: string[], rows: number, side: 'left' | 'right', into: Map<string, { x: number; y: number }>) => {
    if (!ids.length) return
    const used = Math.min(rows, ids.length)
    const rowHeights = Array.from({ length: used }, () => 0)
    ids.forEach((id, i) => (rowHeights[i % rows] = Math.max(rowHeights[i % rows], sizeOf(id).height)))
    const rowTops: number[] = []
    let y = middle - (rowHeights.reduce((a, b) => a + b, 0) + (used - 1) * ROW_GAP) / 2
    for (const h of rowHeights) {
      rowTops.push(y)
      y += h + ROW_GAP
    }
    ids.forEach((id, i) => {
      const column = Math.floor(i / rows)
      const x =
        side === 'right'
          ? anchor.x + center.width + LINK_GAP + column * (cellWidth + COLUMN_GAP)
          : anchor.x - LINK_GAP - cellWidth - column * (cellWidth + COLUMN_GAP)
      into.set(id, { x, y: rowTops[i % rows] })
    })
  }

  // Even around the page, so fitting the bounds puts it in the middle of the screen.
  const centerX = anchor.x + center.width / 2
  const centerY = anchor.y + (center.height - FRAME_LABEL_SPACE) / 2
  const boundsOf = (positions: Map<string, { x: number; y: number }>): Rect => {
    const rects = [...positions].map(([id, p]) => ({ ...p, ...sizeOf(id) }))
    const halfWidth = Math.max(...rects.flatMap((r) => [centerX - r.x, r.x + r.width - centerX]))
    const halfHeight = Math.max(...rects.flatMap((r) => [centerY - (r.y - FRAME_LABEL_SPACE), r.y + r.height - centerY]))
    return { x: centerX - halfWidth, y: centerY - halfHeight, width: 2 * halfWidth, height: 2 * halfHeight }
  }

  // Try every row count and keep the group closest to the target shape.
  let best: { positions: Map<string, { x: number; y: number }>; bounds: Rect; score: number } | null = null
  for (let rows = 1; rows <= Math.max(1, incoming.length, outgoing.length); rows++) {
    const positions = new Map([[centerId, { ...anchor }]])
    placeSide(incoming, rows, 'left', positions)
    placeSide(outgoing, rows, 'right', positions)
    const bounds = boundsOf(positions)
    const score = Math.abs(Math.log(bounds.width / Math.max(bounds.height, 1) / targetAspect))
    if (!best || score < best.score - 1e-9) best = { positions, bounds, score }
  }
  return { positions: best!.positions, bounds: best!.bounds }
}

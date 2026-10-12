import { useMemo } from 'react'
import { screenshotUrl, type CrawlDetail } from '#/lib/queries'
import { frameSize, previewPath, type ViewportId } from '#/lib/viewports'
import { ROOT_SECTION, SITEMAP_SECTION, layoutBoard, type Board } from './layout'

type Page = CrawlDetail['pages'][number]

export interface BoardFrame {
  page: Page
  /** Zero-padded frame number, e.g. "07". */
  number: string
  path: string
  width: number
  height: number
  /** The page is longer than the frame shows. */
  cropped: boolean
  preview: { full: string; small: string } | null
}

export interface BoardSectionInfo {
  id: string
  pageIds: string[]
  /** The page whose links fill this section; null for the start page(s). */
  parent: BoardFrame | null
  title: string
}

export interface BoardModel extends Board {
  frames: Map<string, BoardFrame>
  sectionInfo: BoardSectionInfo[]
}

/** Frame sizes, numbers, sections and auto positions for one viewport's board. */
export function useBoard(detail: CrawlDetail, viewport: ViewportId, aspect: number): BoardModel {
  const { pages, screenshots } = detail
  return useMemo(() => {
    const shots = new Map<string, (typeof screenshots)[number]>()
    for (const shot of screenshots) if (shot.viewport === viewport) shots.set(shot.pageId, shot)

    const sizes = new Map(pages.map((p) => [p.id, frameSize(viewport, shots.get(p.id) ?? null)]))
    const board = layoutBoard(pages, sizes, aspect)
    const digits = Math.max(2, String(pages.length).length)

    const frames = new Map<string, BoardFrame>()
    for (const page of pages) {
      const shot = shots.get(page.id)
      frames.set(page.id, {
        page,
        number: String(board.numbers.get(page.id)).padStart(digits, '0'),
        path: pathOf(page.url),
        ...sizes.get(page.id)!,
        preview: shot
          ? {
              full: screenshotUrl(previewPath(shot.filePath, 'full')),
              small: screenshotUrl(previewPath(shot.filePath, 'small')),
            }
          : null,
      })
    }

    const sectionInfo = board.sections.map((section) => {
      const parent = section.parentPageId ? frames.get(section.parentPageId)! : null
      const title = parent
        ? parent.path
        : section.id === ROOT_SECTION
          ? section.pageIds.length > 1 ? 'Start pages' : 'Start page'
          : section.id === SITEMAP_SECTION
            ? 'Not linked · sitemap.xml'
            : 'Other pages'
      return { id: section.id, pageIds: section.pageIds, parent, title }
    })

    return { ...board, frames, sectionInfo }
  }, [pages, screenshots, viewport, aspect])
}

export function pathOf(url: string) {
  const { pathname, search } = new URL(url)
  return pathname + search
}

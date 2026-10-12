export const VIEWPORTS = {
  // frameWidth: how wide a page frame is drawn on the sitemap board, in board units.
  mobile: { label: 'Mobile', width: 375, height: 812, frameWidth: 150 },
  tablet: { label: 'Tablet', width: 768, height: 1024, frameWidth: 230 },
  desktop: { label: 'Desktop', width: 1440, height: 900, frameWidth: 288 },
} as const

export type ViewportId = keyof typeof VIEWPORTS

export const VIEWPORT_IDS = Object.keys(VIEWPORTS) as [ViewportId, ...ViewportId[]]

/** Tallest a page frame gets on the sitemap board; longer pages are cropped at the bottom. */
export const MAX_FRAME_HEIGHT = 720

/** Frame size on the board for a capture of `shotWidth`×`shotHeight` CSS pixels. */
export function frameSize(viewport: ViewportId, shot: { width: number; height: number } | null) {
  const { frameWidth, width, height } = VIEWPORTS[viewport]
  // Pages without a capture get a placeholder the size of one screen.
  const fullHeight = shot
    ? Math.round((shot.height * frameWidth) / shot.width)
    : Math.round((height * frameWidth) / width)
  return {
    width: frameWidth,
    height: Math.min(fullHeight, MAX_FRAME_HEIGHT),
    cropped: fullHeight > MAX_FRAME_HEIGHT,
  }
}

/**
 * Board previews stored next to each full-page capture: `full` for frames seen
 * up close, `small` for the zoomed-out overview.
 */
export const previewPath = (filePath: string, size: 'full' | 'small' = 'full') =>
  filePath.replace(/\.jpg$/, size === 'full' ? '.preview.webp' : '.preview-sm.webp')

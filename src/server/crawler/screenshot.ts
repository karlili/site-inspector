import path from 'node:path'
import sharp from 'sharp'
import type { Page } from 'playwright'
import { MAX_FRAME_HEIGHT, VIEWPORTS, previewPath, type ViewportId } from '#/lib/viewports'
import type { ScreenshotStore } from '../storage'

/** Chromium can't render captures much taller than this. */
const MAX_CAPTURE_HEIGHT = 16_000
const THUMB_WIDTH = 320
const PREVIEW_WIDTHS = { full: 480, small: 144 } as const

/** Scroll through the page so lazy-loaded images and sections render. */
export async function autoScroll(page: Page) {
  await page.evaluate(async (maxHeight) => {
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8))
    for (let y = 0; y < Math.min(document.body.scrollHeight, maxHeight); y += step) {
      window.scrollTo(0, y)
      await new Promise((r) => setTimeout(r, 60))
    }
    window.scrollTo(0, 0)
  }, MAX_CAPTURE_HEIGHT)
}

export interface CapturedScreenshot {
  width: number
  height: number
  filePath: string
  thumbPath: string
}

/**
 * Full-page capture of an already-loaded page, saved to `store` under `relDir`.
 * The paths returned are the capture's and thumbnail's storage keys.
 */
export async function captureScreenshot(
  page: Page,
  viewport: ViewportId,
  store: ScreenshotStore,
  relDir: string,
  baseName: string,
): Promise<CapturedScreenshot> {
  await autoScroll(page)
  await page.waitForTimeout(300)

  // On touch devices a page without a device-width viewport meta lays out wider
  // than the screen (980px by default) and the device zooms out to show all of it.
  const { layoutWidth, fullHeight } = await page.evaluate(() => ({
    layoutWidth: window.innerWidth,
    fullHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
  }))
  const { width, height: viewportHeight } = VIEWPORTS[viewport]
  const captureWidth = Math.max(width, layoutWidth)
  const zoom = width / captureWidth
  const captureHeight = Math.min(
    Math.max(fullHeight, Math.ceil(viewportHeight / zoom)),
    MAX_CAPTURE_HEIGHT,
  )
  const height = Math.round(captureHeight * zoom)

  const filePath = path.posix.join(relDir, `${baseName}-${viewport}.jpg`)
  const thumbPath = path.posix.join(relDir, `${baseName}-${viewport}.thumb.webp`)

  const zoomedOut = captureWidth > width
  const shot = await page.screenshot({
    // Lossless when it will be resized, so the JPEG is only encoded once.
    ...(zoomedOut ? { type: 'png' } : { type: 'jpeg', quality: 82 }),
    fullPage: true,
    clip: { x: 0, y: 0, width: captureWidth, height: captureHeight },
    animations: 'disabled',
    // Stored at CSS-pixel size whatever the device pixel ratio.
    scale: 'css',
  })
  const buffer = zoomedOut
    ? await sharp(shot).resize({ width, height, fit: 'fill' }).jpeg({ quality: 82 }).toBuffer()
    : shot
  // Thumbnail shows the first screen of the page at the viewport's aspect ratio.
  const thumb = await sharp(buffer)
    .resize({
      width: THUMB_WIDTH,
      height: Math.round((THUMB_WIDTH * viewportHeight) / width),
      fit: 'cover',
      position: 'top',
    })
    .webp({ quality: 75 })
    .toBuffer()

  await Promise.all([
    store.put(filePath, buffer, 'image/jpeg'),
    store.put(thumbPath, thumb, 'image/webp'),
    writePreviews(buffer, viewport, filePath, store),
  ])

  return { width, height, filePath, thumbPath }
}

/**
 * Sitemap board previews: the part of the page a full-height frame shows (see
 * MAX_FRAME_HEIGHT), scaled down to each preview size. `source` is the
 * full-page JPEG stored at `captureKey`; the previews are stored next to it.
 */
export async function writePreviews(
  source: Buffer,
  viewport: ViewportId,
  captureKey: string,
  store: ScreenshotStore,
) {
  const { width = 0, height = 0 } = await sharp(source).metadata()
  const visibleHeight = (MAX_FRAME_HEIGHT * width) / VIEWPORTS[viewport].frameWidth
  await Promise.all(
    (Object.keys(PREVIEW_WIDTHS) as (keyof typeof PREVIEW_WIDTHS)[]).map(async (size) => {
      const outWidth = Math.min(width, PREVIEW_WIDTHS[size])
      const scale = outWidth / width
      // Resizing before cropping lets libvips shrink the JPEG while decoding it,
      // which roughly halves the time for tall pages.
      const preview = await sharp(source)
        .resize({ width: outWidth })
        .extract({
          left: 0,
          top: 0,
          width: outWidth,
          height: Math.min(Math.floor(height * scale), Math.round(visibleHeight * scale)),
        })
        .webp({ quality: 72 })
        .toBuffer()
      await store.put(previewPath(captureKey, size), preview, 'image/webp')
    }),
  )
}

import fs from 'node:fs/promises'
import path from 'node:path'
import { defineHandler } from 'nitro'
import { VIEWPORT_IDS, type ViewportId } from '#/lib/viewports'
import { writePreviews } from './crawler/screenshot'
import { SCREENSHOT_DIR } from './paths'

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

const PREVIEW_SUFFIX = /-(\w+)\.preview(?:-sm)?\.webp$/
/** Captures whose previews are being generated right now, so parallel requests share one sharp run. */
const pendingPreviews = new Map<string, Promise<void>>()

/**
 * Serves captured screenshots from the data directory. Registered as a Nitro
 * route (see vite.config.ts) rather than a TanStack server route because the
 * Nitro dev server treats `<img>` requests as static assets unless a Nitro
 * route claims the path.
 */
export default defineHandler(async (event) => {
  const relPath = decodeURIComponent(event.url.pathname.slice('/screenshots/'.length))
  const filePath = path.resolve(SCREENSHOT_DIR, relPath)
  const contentType = CONTENT_TYPES[path.extname(filePath)]
  // Refuse anything that escapes the screenshot directory.
  if (!filePath.startsWith(SCREENSHOT_DIR + path.sep) || !contentType) {
    return new Response('Not found', { status: 404 })
  }
  try {
    const body = await fs.readFile(filePath).catch(async (err) => {
      if (err.code !== 'ENOENT' || !(await createMissingPreview(filePath))) throw err
      return fs.readFile(filePath)
    })
    return new Response(body, {
      headers: {
        'Content-Type': contentType,
        // File names are unique per page id, so they never change.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
})

/** Crawls captured before board previews existed get theirs on first request. */
async function createMissingPreview(previewFile: string): Promise<boolean> {
  const viewport = previewFile.match(PREVIEW_SUFFIX)?.[1]
  if (!viewport || !VIEWPORT_IDS.includes(viewport as ViewportId)) return false
  const capture = previewFile.replace(/\.preview(?:-sm)?\.webp$/, '.jpg')
  let pending = pendingPreviews.get(capture)
  if (!pending) {
    pending = writePreviews(capture, viewport as ViewportId, capture).finally(() =>
      pendingPreviews.delete(capture),
    )
    pendingPreviews.set(capture, pending)
  }
  return pending.then(
    () => true,
    () => false,
  )
}

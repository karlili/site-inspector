import path from 'node:path'
import { defineHandler } from 'nitro'
import { VIEWPORT_IDS, type ViewportId } from '#/lib/viewports'
import { writePreviews } from './crawler/screenshot'
import { screenshotStore } from './storage'

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

const PREVIEW_SUFFIX = /-(\w+)\.preview(?:-sm)?\.webp$/
/** Captures whose previews are being generated right now, so parallel requests share one sharp run. */
const pendingPreviews = new Map<string, Promise<boolean>>()

/**
 * Serves captured screenshots from the screenshot store (local disk or a
 * bucket). Registered as a Nitro route (see vite.config.ts) rather than a
 * TanStack server route because the Nitro dev server treats `<img>` requests
 * as static assets unless a Nitro route claims the path.
 */
export default defineHandler(async (event) => {
  const key = decodeURIComponent(event.url.pathname.slice('/screenshots/'.length))
  const contentType = CONTENT_TYPES[path.posix.extname(key)]
  // Keys are `<crawl id>/<file>`; refuse anything else, such as `..` segments.
  const segments = key.split('/')
  if (!contentType || segments.some((s) => !s || s === '.' || s === '..' || s.includes('\\'))) {
    return new Response('Not found', { status: 404 })
  }
  try {
    const store = screenshotStore()
    let body = await store.get(key)
    if (!body && (await createMissingPreview(key))) body = await store.get(key)
    if (!body) return new Response('Not found', { status: 404 })
    return new Response(new Uint8Array(body), {
      headers: {
        'Content-Type': contentType,
        // Keys are unique per capture, so they never change.
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    })
  } catch {
    return new Response('Not found', { status: 404 })
  }
})

/** Crawls captured before board previews existed get theirs on first request. */
function createMissingPreview(previewKey: string): Promise<boolean> {
  const viewport = previewKey.match(PREVIEW_SUFFIX)?.[1]
  if (!viewport || !VIEWPORT_IDS.includes(viewport as ViewportId)) return Promise.resolve(false)
  const capture = previewKey.replace(/\.preview(?:-sm)?\.webp$/, '.jpg')
  let pending = pendingPreviews.get(capture)
  if (!pending) {
    const store = screenshotStore()
    pending = store
      .get(capture)
      .then(async (source) => {
        if (!source) return false
        await writePreviews(source, viewport as ViewportId, capture, store)
        return true
      })
      .catch(() => false)
      .finally(() => pendingPreviews.delete(capture))
    pendingPreviews.set(capture, pending)
  }
  return pending
}

import type { PageStatus } from './schemas'

type HealthPage = {
  id: string
  depth: number
  status: PageStatus
  httpStatus: number | null
  error: string | null
}
type HealthLink = { fromPageId: string; toPageId: string }

/**
 * A link to this page is broken: it answered with an error status, or never
 * loaded at all. Pages the crawler chose not to capture (downloads, redirects
 * to other sites) and its own failures (a lost runner) aren't the site's fault.
 */
export function isBrokenTarget(page: Pick<HealthPage, 'status' | 'httpStatus' | 'error'>): boolean {
  if (page.httpStatus != null) return page.httpStatus >= 400
  return page.status === 'failed' && /net::ERR_|Timeout/.test(page.error ?? '')
}

export interface LinkHealth {
  /** Pages that links to are broken. */
  brokenTargets: Set<string>
  /** For each page with broken links, the pages they point to, in no particular order. */
  brokenOut: Map<string, string[]>
  /** Pages that can't be reached from the start page by following links. */
  orphans: Set<string>
  /** Every page with one of the problems above. */
  issueIds: Set<string>
}

export function analyzeLinks(pages: HealthPage[], links: HealthLink[]): LinkHealth {
  const brokenTargets = new Set(pages.filter(isBrokenTarget).map((p) => p.id))

  const brokenOut = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  for (const { fromPageId: from, toPageId: to } of links) {
    if (from === to) continue
    outgoing.set(from, [...(outgoing.get(from) ?? []), to])
    if (brokenTargets.has(to)) brokenOut.set(from, [...(brokenOut.get(from) ?? []), to])
  }

  const orphans = new Set<string>()
  const root = pages.find((p) => p.depth === 0)
  if (root) {
    const reached = new Set([root.id])
    const queue = [root.id]
    for (let i = 0; i < queue.length; i++) {
      for (const next of outgoing.get(queue[i]) ?? []) {
        if (!reached.has(next)) {
          reached.add(next)
          queue.push(next)
        }
      }
    }
    for (const page of pages) if (!reached.has(page.id)) orphans.add(page.id)
  }

  return {
    brokenTargets,
    brokenOut,
    orphans,
    issueIds: new Set([...brokenTargets, ...brokenOut.keys(), ...orphans]),
  }
}

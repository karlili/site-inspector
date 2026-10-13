import { isBrokenTarget } from './linkHealth'
import type { PageSource, PageStatus } from './schemas'

type VariantPage = {
  id: string
  url: string
  title: string | null
  status: PageStatus
  httpStatus: number | null
  error: string | null
  parentPageId: string | null
  source: PageSource
}
type VariantLink = { fromPageId: string; toPageId: string }

/** The URL without a trailing slash on its path, so `/a` and `/a/` share a key. */
export function slashKey(url: string): string {
  const parsed = new URL(url)
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/$/, '')
  return parsed.toString()
}

export interface SlashGroups<P extends VariantPage = VariantPage> {
  /** The group each page belongs to, named after its first-discovered page. */
  groupOf: Map<string, string>
  /** The pages of each group with more than one URL, in discovery order. */
  variants: Map<string, P[]>
  /** Groups whose URLs the site answers with different pages. */
  conflicts: Set<string>
}

/**
 * The crawl keeps `/a` and `/a/` apart because a server may answer them
 * differently; the board shows them as one frame. `pages` must be in discovery
 * order. Two captured URLs count as different pages when their titles or HTTP
 * statuses differ (a redirect from one to the other gives the same title).
 */
export function groupSlashVariants<P extends VariantPage>(pages: P[]): SlashGroups<P> {
  const byKey = new Map<string, P[]>()
  for (const page of pages) {
    const key = slashKey(page.url)
    byKey.set(key, [...(byKey.get(key) ?? []), page])
  }

  const groupOf = new Map<string, string>()
  const variants = new Map<string, P[]>()
  const conflicts = new Set<string>()
  for (const members of byKey.values()) {
    const groupId = members[0].id
    for (const page of members) groupOf.set(page.id, groupId)
    if (members.length < 2) continue
    variants.set(groupId, members)
    const captured = members.filter((p) => p.status === 'done')
    if (new Set(captured.map((p) => `${p.httpStatus} ${p.title ?? ''}`)).size > 1) conflicts.add(groupId)
  }
  return { groupOf, variants, conflicts }
}

/**
 * The crawl as the board shows it: one page per group, placed under the page
 * that first linked to any of its URLs, and links between groups.
 */
export function foldSlashVariants<P extends VariantPage, L extends VariantLink>(
  pages: P[],
  links: L[],
  { groupOf, variants }: SlashGroups<P>,
): { pages: P[]; links: L[] } {
  const group = (id: string) => groupOf.get(id) ?? id
  const folded = pages.flatMap((page) => {
    if (group(page.id) !== page.id) return []
    const linked = variants.get(page.id)?.find((p) => p.source === 'link') ?? page
    const parentPageId = linked.parentPageId && group(linked.parentPageId)
    if (linked === page && parentPageId === page.parentPageId) return [page]
    return [{ ...page, source: linked.source, parentPageId }]
  })

  const seen = new Set<string>()
  const foldedLinks = links.flatMap((link) => {
    const fromPageId = group(link.fromPageId)
    const toPageId = group(link.toPageId)
    const key = `${fromPageId}>${toPageId}`
    if (seen.has(key)) return []
    seen.add(key)
    return [fromPageId === link.fromPageId && toPageId === link.toPageId ? link : { ...link, fromPageId, toPageId }]
  })
  return { pages: folded, links: foldedLinks }
}

/** Folded pages for link health: a group is a broken target when any of its URLs is. */
export function healthPages<P extends VariantPage>(folded: P[], { variants }: SlashGroups<P>): P[] {
  return folded.map((page) => {
    const broken = variants.get(page.id)?.find(isBrokenTarget)
    return broken && broken.id !== page.id
      ? { ...page, status: broken.status, httpStatus: broken.httpStatus, error: broken.error }
      : page
  })
}

import { describe, expect, it } from 'vitest'
import { foldSlashVariants, groupSlashVariants, healthPages, slashKey } from './slashVariants'

const page = (id: string, path: string, extra: Partial<Parameters<typeof groupSlashVariants>[0][number]> = {}) => ({
  id,
  url: `https://example.com${path}`,
  title: path,
  status: 'done' as const,
  httpStatus: 200,
  error: null,
  parentPageId: 'root' as string | null,
  source: 'link' as const,
  ...extra,
})
const link = (fromPageId: string, toPageId: string) => ({ fromPageId, toPageId })

describe('slashKey', () => {
  it('drops a trailing slash but keeps the root and the query', () => {
    expect(slashKey('https://example.com/a/')).toBe('https://example.com/a')
    expect(slashKey('https://example.com/a/?q=1')).toBe('https://example.com/a?q=1')
    expect(slashKey('https://example.com/')).toBe('https://example.com/')
  })
})

describe('groupSlashVariants', () => {
  const root = page('root', '/', { parentPageId: null })

  it('groups /a and /a/ under the first one discovered', () => {
    const groups = groupSlashVariants([root, page('a', '/a/', { title: 'A' }), page('a2', '/a', { title: 'A' })])
    expect(groups.groupOf.get('a2')).toBe('a')
    expect(groups.variants.get('a')?.map((p) => p.id)).toEqual(['a', 'a2'])
    expect(groups.variants.has('root')).toBe(false)
    expect(groups.conflicts.size).toBe(0)
  })

  it('flags groups whose URLs show different pages', () => {
    const groups = groupSlashVariants([
      root,
      page('a', '/a', { title: 'Section' }),
      page('a2', '/a/', { title: 'A to Z' }),
      page('b', '/b', { httpStatus: 404, title: 'B' }),
      page('b2', '/b/', { title: 'B' }),
    ])
    expect([...groups.conflicts]).toEqual(['a', 'b'])
  })

  it('waits until both URLs are captured', () => {
    const groups = groupSlashVariants([root, page('a', '/a'), page('a2', '/a/', { status: 'pending', title: null })])
    expect(groups.conflicts.size).toBe(0)
  })
})

describe('foldSlashVariants', () => {
  it('keeps one page per group and points links and parents at it', () => {
    const pages = [
      page('root', '/', { parentPageId: null }),
      page('a', '/a'),
      page('a2', '/a/'),
      page('c', '/a/c', { parentPageId: 'a2' }),
    ]
    const groups = groupSlashVariants(pages)
    const folded = foldSlashVariants(pages, [link('root', 'a'), link('root', 'a2'), link('a2', 'c')], groups)
    expect(folded.pages.map((p) => [p.id, p.parentPageId])).toEqual([
      ['root', null],
      ['a', 'root'],
      ['c', 'a'],
    ])
    expect(folded.links).toEqual([link('root', 'a'), link('a', 'c')])
  })

  it('places a group by its linked URL when the first one only came from sitemap.xml', () => {
    const pages = [
      page('root', '/', { parentPageId: null }),
      page('a', '/a', { source: 'sitemap', parentPageId: null }),
      page('a2', '/a/', { parentPageId: 'root' }),
    ]
    const folded = foldSlashVariants(pages, [], groupSlashVariants(pages))
    expect(folded.pages[1]).toMatchObject({ id: 'a', source: 'link', parentPageId: 'root' })
  })
})

describe('healthPages', () => {
  it('marks a group broken when any of its URLs is', () => {
    const pages = [page('root', '/', { parentPageId: null }), page('a', '/a'), page('a2', '/a/', { httpStatus: 404 })]
    const groups = groupSlashVariants(pages)
    const folded = foldSlashVariants(pages, [], groups).pages
    expect(healthPages(folded, groups).find((p) => p.id === 'a')?.httpStatus).toBe(404)
  })
})

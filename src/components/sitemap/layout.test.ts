import { describe, expect, it } from 'vitest'
import { ROOT_SECTION, SITEMAP_SECTION, layoutBoard, sectionBounds, type BoardPage } from './layout'

const size = { width: 288, height: 400 }
const sizesFor = (pages: BoardPage[]) => new Map(pages.map((p) => [p.id, size]))

function overlaps(a: { x: number; y: number }, b: { x: number; y: number }) {
  return a.x < b.x + size.width && b.x < a.x + size.width && a.y < b.y + size.height && b.y < a.y + size.height
}

describe('layoutBoard', () => {
  // root → a, b; a → c, d; b → e
  const pages: BoardPage[] = [
    { id: 'root', parentPageId: null },
    { id: 'a', parentPageId: 'root' },
    { id: 'b', parentPageId: 'root' },
    { id: 'e', parentPageId: 'b' },
    { id: 'c', parentPageId: 'a' },
    { id: 'd', parentPageId: 'a' },
  ]

  it('groups pages by the page that discovered them, breadth-first', () => {
    const board = layoutBoard(pages, sizesFor(pages))
    expect(board.sections.map((s) => [s.id, s.pageIds])).toEqual([
      [ROOT_SECTION, ['root']],
      ['root', ['a', 'b']],
      ['a', ['c', 'd']],
      ['b', ['e']],
    ])
    // Numbers follow the sections, so each section reads in sequence.
    expect(board.order).toEqual(['root', 'a', 'b', 'c', 'd', 'e'])
    expect(board.numbers.get('c')).toBe(4)
    expect(board.sectionOf.get('e')).toBe('b')
  })

  it('puts pages found only in sitemap.xml in a last section of their own', () => {
    const withOrphans: BoardPage[] = [
      ...pages.slice(0, 3),
      { id: 'o1', parentPageId: null, source: 'sitemap' },
      { id: 'o2', parentPageId: null, source: 'sitemap' },
    ]
    const board = layoutBoard(withOrphans, sizesFor(withOrphans))
    expect(board.sections.map((s) => [s.id, s.pageIds])).toEqual([
      [ROOT_SECTION, ['root']],
      ['root', ['a', 'b']],
      [SITEMAP_SECTION, ['o1', 'o2']],
    ])
    expect(board.order).toEqual(['root', 'a', 'b', 'o1', 'o2'])
  })

  it('places every frame without overlaps', () => {
    const board = layoutBoard(pages, sizesFor(pages))
    const placed = [...board.positions.values()]
    expect(placed).toHaveLength(pages.length)
    for (let i = 0; i < placed.length; i++) {
      for (let j = i + 1; j < placed.length; j++) expect(overlaps(placed[i], placed[j])).toBe(false)
    }
  })

  it('wraps a large section into a grid instead of one long row', () => {
    const many: BoardPage[] = [
      { id: 'root', parentPageId: null },
      ...Array.from({ length: 99 }, (_, i) => ({ id: `p${i}`, parentPageId: 'root' })),
    ]
    const board = layoutBoard(many, sizesFor(many))
    const xs = new Set([...board.positions.values()].map((p) => p.x))
    const ys = new Set([...board.positions.values()].map((p) => p.y))
    expect(xs.size).toBeGreaterThan(5)
    expect(ys.size).toBeGreaterThan(5)
    const right = Math.max(...[...board.positions.values()].map((p) => p.x)) + size.width
    const bottom = Math.max(...[...board.positions.values()].map((p) => p.y)) + size.height
    expect(right / bottom).toBeGreaterThan(1)
    expect(right / bottom).toBeLessThan(2.5)
  })

  it('keeps sections from overlapping each other', () => {
    const board = layoutBoard(pages, sizesFor(pages))
    const boxes = board.sections.map((s) =>
      sectionBounds(s.pageIds.map((id) => ({ ...board.positions.get(id)!, ...size }))),
    )
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i], boxes[j]]
        const hit = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
        expect(hit).toBe(false)
      }
    }
  })

  it('still places pages whose parent is missing', () => {
    const board = layoutBoard(
      [
        { id: 'x', parentPageId: 'gone' },
        { id: 'y', parentPageId: 'y' },
      ],
      new Map([
        ['x', size],
        ['y', size],
      ]),
    )
    expect(board.order).toEqual(['x', 'y'])
    expect(board.positions.size).toBe(2)
  })

  it('handles an empty crawl', () => {
    const board = layoutBoard([], new Map())
    expect(board.order).toEqual([])
    expect(board.sections).toEqual([])
  })
})

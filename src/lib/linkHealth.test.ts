import { describe, expect, it } from 'vitest'
import { analyzeLinks, isBrokenTarget } from './linkHealth'

const page = (id: string, extra: Partial<Parameters<typeof analyzeLinks>[0][number]> = {}) => ({
  id,
  depth: id === 'root' ? 0 : 1,
  status: 'done' as const,
  httpStatus: 200,
  error: null,
  ...extra,
})
const link = (fromPageId: string, toPageId: string) => ({ fromPageId, toPageId })

describe('isBrokenTarget', () => {
  it('counts error statuses and pages that never loaded', () => {
    expect(isBrokenTarget(page('a', { httpStatus: 404 }))).toBe(true)
    expect(isBrokenTarget(page('a', { httpStatus: 503, status: 'failed', error: 'x' }))).toBe(true)
    expect(isBrokenTarget(page('a', { httpStatus: null, status: 'failed', error: 'page.goto: net::ERR_NAME_NOT_RESOLVED at …' }))).toBe(true)
    expect(isBrokenTarget(page('a', { httpStatus: null, status: 'failed', error: 'page.goto: Timeout 30000ms exceeded.' }))).toBe(true)
  })

  it("doesn't count pages the crawler skipped or lost", () => {
    expect(isBrokenTarget(page('a'))).toBe(false)
    expect(isBrokenTarget(page('a', { httpStatus: 301 }))).toBe(false)
    // A download answers 200; the crawler just doesn't capture it.
    expect(isBrokenTarget(page('a', { status: 'failed', error: 'Not an HTML page (application/octet-stream)' }))).toBe(false)
    expect(isBrokenTarget(page('a', { status: 'failed', error: 'Redirected off-site to https://x.test/' }))).toBe(false)
    expect(isBrokenTarget(page('a', { httpStatus: null, status: 'failed', error: 'Runner lost while capturing' }))).toBe(false)
    expect(isBrokenTarget(page('a', { httpStatus: null, status: 'pending' }))).toBe(false)
  })
})

describe('analyzeLinks', () => {
  it('finds broken links, the pages holding them, and pages no link leads to', () => {
    const pages = [
      page('root'),
      page('a'),
      page('gone', { httpStatus: 404 }),
      // Its only referrer is itself and another orphan.
      page('stray'),
      page('stray2'),
    ]
    const links = [
      link('root', 'a'),
      link('root', 'gone'),
      link('a', 'gone'),
      link('a', 'root'),
      link('stray', 'stray'),
      link('stray2', 'stray'),
      link('stray2', 'gone'),
    ]
    const health = analyzeLinks(pages, links)
    expect([...health.brokenTargets]).toEqual(['gone'])
    expect(Object.fromEntries(health.brokenOut)).toEqual({ root: ['gone'], a: ['gone'], stray2: ['gone'] })
    expect([...health.orphans].sort()).toEqual(['stray', 'stray2'])
    expect([...health.issueIds].sort()).toEqual(['a', 'gone', 'root', 'stray', 'stray2'])
  })

  it('makes a page an orphan once its only referrer stops linking to it', () => {
    const pages = [page('root'), page('a'), page('b')]
    expect(analyzeLinks(pages, [link('root', 'a'), link('a', 'b')]).orphans.size).toBe(0)
    expect([...analyzeLinks(pages, [link('root', 'a')]).orphans]).toEqual(['b'])
  })
})

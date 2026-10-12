import { describe, expect, it } from 'vitest'
import { parseRobots } from './robots'

describe('parseRobots', () => {
  const robots = parseRobots(`
User-agent: Googlebot
Disallow: /

User-agent: *
Disallow: /private
Allow: /private/public
Disallow: /*.json$
`)

  it('applies only the wildcard group', () => {
    expect(robots.isAllowed('https://x.com/')).toBe(true)
    expect(robots.isAllowed('https://x.com/about')).toBe(true)
  })

  it('uses the longest matching rule', () => {
    expect(robots.isAllowed('https://x.com/private/secret')).toBe(false)
    expect(robots.isAllowed('https://x.com/private/public/page')).toBe(true)
  })

  it('supports wildcards and end anchors', () => {
    expect(robots.isAllowed('https://x.com/data/feed.json')).toBe(false)
    expect(robots.isAllowed('https://x.com/data/feed.json?x=1')).toBe(true)
  })
})

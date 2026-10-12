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

describe('Crawl-delay', () => {
  it('reads it from the wildcard group only', () => {
    const rules = parseRobots('User-agent: Googlebot\nCrawl-delay: 10\n\nUser-agent: *\nCrawl-delay: 1.5\nDisallow: /x')
    expect(rules.crawlDelayMs).toBe(1500)
    expect(rules.isAllowed('https://x.com/x')).toBe(false)
    expect(parseRobots('User-agent: Googlebot\nCrawl-delay: 10').crawlDelayMs).toBeUndefined()
  })

  it('keeps it when there are no path rules', () => {
    const rules = parseRobots('User-agent: *\nCrawl-delay: 2')
    expect(rules.crawlDelayMs).toBe(2000)
    expect(rules.isAllowed('https://x.com/anything')).toBe(true)
  })

  it('ignores values that are not numbers', () => {
    expect(parseRobots('User-agent: *\nCrawl-delay: soon').crawlDelayMs).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { isSameSite, looksLikeHtml, normalizeUrl } from './url'

describe('normalizeUrl', () => {
  it('canonicalizes equivalent URLs to the same string', () => {
    const variants = [
      'https://Example.com/about',
      'https://example.com:443/about',
      'https://example.com/about#team',
      'https://example.com/about?utm_source=x',
      'https://example.com//about',
    ]
    expect(new Set(variants.map((v) => normalizeUrl(v)))).toEqual(
      new Set(['https://example.com/about']),
    )
  })

  it('keeps the root slash and strips index files', () => {
    expect(normalizeUrl('https://example.com')).toBe('https://example.com/')
    expect(normalizeUrl('https://example.com/docs/index.html')).toBe('https://example.com/docs/')
  })

  it('keeps trailing slashes, which can name a different page', () => {
    expect(normalizeUrl('https://example.com/site/atoz/')).toBe('https://example.com/site/atoz/')
    expect(normalizeUrl('https://example.com/site/atoz')).toBe('https://example.com/site/atoz')
  })

  it('sorts query params', () => {
    expect(normalizeUrl('https://example.com/s?b=2&a=1')).toBe('https://example.com/s?a=1&b=2')
  })

  it('resolves relative URLs against a base', () => {
    expect(normalizeUrl('../x', 'https://example.com/a/b/c')).toBe('https://example.com/a/x')
  })

  it('rejects non-http schemes and garbage', () => {
    for (const raw of ['mailto:a@b.c', 'tel:123', 'javascript:void(0)', 'ftp://x.com', '::']) {
      expect(normalizeUrl(raw)).toBeNull()
    }
  })
})

describe('isSameSite', () => {
  it('treats www and apex as the same site', () => {
    expect(isSameSite('https://www.example.com/a', 'example.com')).toBe(true)
    expect(isSameSite('http://example.com/a', 'www.example.com')).toBe(true)
  })

  it('rejects other subdomains and domains', () => {
    expect(isSameSite('https://blog.example.com/', 'example.com')).toBe(false)
    expect(isSameSite('https://example.org/', 'example.com')).toBe(false)
    expect(isSameSite('https://notexample.com/', 'example.com')).toBe(false)
  })
})

describe('looksLikeHtml', () => {
  it('skips obvious asset and document files', () => {
    expect(looksLikeHtml('https://example.com/report.pdf')).toBe(false)
    expect(looksLikeHtml('https://example.com/logo.PNG')).toBe(false)
    expect(looksLikeHtml('https://example.com/page')).toBe(true)
    expect(looksLikeHtml('https://example.com/page.html')).toBe(true)
  })
})

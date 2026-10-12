/** Minimal robots.txt support: `Disallow`/`Allow` rules and `Crawl-delay` for `User-agent: *`. */
export interface RobotsRules {
  isAllowed(url: string): boolean
  /** How long the site asks crawlers to wait between requests. */
  crawlDelayMs?: number
}

const allowAll: RobotsRules = { isAllowed: () => true }

export function parseRobots(text: string): RobotsRules {
  const rules: { allow: boolean; pattern: RegExp; length: number }[] = []
  let crawlDelayMs: number | undefined
  let applies = false
  let lastWasAgent = false

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim()
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line)
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()

    if (key === 'user-agent') {
      // Consecutive user-agent lines form one group.
      applies = (lastWasAgent && applies) || value === '*'
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (applies && key === 'crawl-delay') {
      const seconds = Number(value)
      if (value && Number.isFinite(seconds) && seconds >= 0) crawlDelayMs = Math.round(seconds * 1000)
      continue
    }
    if (!applies || (key !== 'allow' && key !== 'disallow') || !value) continue

    const source = value
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\\\$$/, '$')
    rules.push({ allow: key === 'allow', pattern: new RegExp(`^${source}`), length: value.length })
  }

  if (rules.length === 0) return crawlDelayMs === undefined ? allowAll : { ...allowAll, crawlDelayMs }
  return {
    crawlDelayMs,
    isAllowed(url) {
      const { pathname, search } = new URL(url)
      const target = pathname + search
      // Longest matching rule wins, as per RFC 9309.
      let best: (typeof rules)[number] | undefined
      for (const rule of rules) {
        if (rule.pattern.test(target) && (!best || rule.length > best.length)) best = rule
      }
      return best ? best.allow : true
    },
  }
}

/** The site's robots.txt, or null if there isn't one (which allows everything). */
export async function fetchRobotsText(origin: string): Promise<string | null> {
  try {
    const res = await fetch(new URL('/robots.txt', origin), {
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

import { randomUUID } from 'node:crypto'
import os from 'node:os'
import type { Browser } from 'playwright'
import type { Db } from '#/server/db/client'
import { CrawlCancelled, capturePage, errorMessage, launchBrowser } from '#/server/crawler/crawl'
import {
  claimNextPage,
  completePage,
  heartbeat,
  isCrawlActive,
  reapExpiredLeases,
  registerRunner,
  removeRunner,
  type ClaimedJob,
} from '#/server/crawler/jobs'
import { parseRobots, type RobotsRules } from '#/server/crawler/robots'
import { getRunnerSettings } from '#/server/crawler/settings'
import { screenshotStore, type ScreenshotStore } from '#/server/storage'

export interface RunnerOptions {
  db: Db
  id?: string
  /** Pages this runner captures at once. Unset: follow the slots-per-runner setting. */
  concurrency?: number
  /** Where captures are saved; defaults to the store the environment configures. */
  store?: ScreenshotStore
  /** How long an idle slot waits before looking for work again. */
  pollMs?: number
  heartbeatMs?: number
  log?: (message: string) => void
}

/**
 * Captures pages from the shared queue until stopped. Independent of the admin
 * server: start as many as you like against the same database and screenshot store.
 */
export class Runner {
  readonly id: string
  private readonly db: Db
  /** Set when the slot count was given explicitly rather than taken from settings. */
  private readonly pinnedConcurrency?: number
  private targetConcurrency = 0
  private readonly store: ScreenshotStore
  private readonly pollMs: number
  private readonly heartbeatMs: number
  private readonly log: (message: string) => void

  private browser?: Promise<{ browser: Browser; userAgent: string }>
  private readonly active = new Set<string>()
  private readonly robots = new Map<string, { text: string | null; rules?: RobotsRules }>()
  private readonly sleepers = new Set<() => void>()
  private readonly slots = new Map<number, Promise<void>>()
  private heartbeatTimer?: NodeJS.Timeout
  private beating?: Promise<void>
  private stopping = false

  constructor(options: RunnerOptions) {
    this.db = options.db
    this.id = options.id ?? `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
    this.pinnedConcurrency = options.concurrency
    this.store = options.store ?? screenshotStore()
    this.pollMs = options.pollMs ?? 1000
    this.heartbeatMs = options.heartbeatMs ?? 15_000
    this.log = options.log ?? (() => {})
  }

  /** Pages this runner captures at once. */
  get concurrency() {
    return this.targetConcurrency
  }

  async start() {
    this.targetConcurrency = this.pinnedConcurrency ?? (await getRunnerSettings(this.db)).slotsPerRunner
    await registerRunner(this.db, {
      id: this.id,
      hostname: os.hostname(),
      pid: process.pid,
      concurrency: this.concurrency,
    })
    await this.getBrowser()
    await this.beat()
    this.heartbeatTimer = setInterval(() => void this.beat(), this.heartbeatMs)
    this.resize(this.targetConcurrency)
  }

  /** Stop claiming, let in-flight pages finish, then shut down. */
  async stop() {
    this.stopping = true
    for (const wake of this.sleepers) wake()
    await Promise.all(this.slots.values())
    clearInterval(this.heartbeatTimer)
    await this.beating
    await removeRunner(this.db, this.id).catch((err) => this.log(`unregister failed: ${errorMessage(err)}`))
    const browser = await this.browser?.catch(() => undefined)
    await browser?.browser.close().catch(() => {})
  }

  /** Skips a beat while the previous one is still running (e.g. the database is slow). */
  private beat() {
    this.beating ??= this.doBeat().finally(() => (this.beating = undefined))
    return this.beating
  }

  private async doBeat() {
    try {
      if (this.pinnedConcurrency === undefined) {
        const { slotsPerRunner } = await getRunnerSettings(this.db)
        if (slotsPerRunner !== this.targetConcurrency) {
          this.log(`slots ${this.targetConcurrency} -> ${slotsPerRunner}`)
          this.resize(slotsPerRunner)
        }
      }
      await reapExpiredLeases(this.db)
      await heartbeat(this.db, this.id, [...this.active], Date.now(), this.concurrency)
    } catch (err) {
      this.log(`heartbeat failed: ${errorMessage(err)}`)
    }
  }

  /** Start missing slots up to `n`; slots beyond it stop after their current page. */
  private resize(n: number) {
    const shrinking = n < this.targetConcurrency
    this.targetConcurrency = n
    if (this.stopping) return
    for (let i = 0; i < n; i++) {
      if (!this.slots.has(i)) this.slots.set(i, this.runSlot(i))
    }
    // Idle slots above the new count can leave now rather than after their nap.
    if (shrinking) for (const wake of this.sleepers) wake()
  }

  private async runSlot(index: number) {
    while (!this.stopping && index < this.targetConcurrency) {
      let job: ClaimedJob | null = null
      try {
        job = await claimNextPage(this.db, this.id)
      } catch (err) {
        this.log(`claim failed: ${errorMessage(err)}`)
      }
      if (!job) {
        // Jitter so idle runners don't all hit the database in lockstep.
        await this.sleep(this.pollMs * (0.75 + Math.random() / 2))
        continue
      }
      this.active.add(job.page.id)
      try {
        await this.process(job)
      } finally {
        this.active.delete(job.page.id)
      }
    }
    // No await since the loop check, so resize() can't miss this slot leaving.
    this.slots.delete(index)
  }

  private async process(job: ClaimedJob) {
    const { page, crawl } = job
    this.log(`claimed ${page.url} (crawl ${crawl.id}, depth ${page.depth})`)
    let kept = false
    const captureId = randomUUID().slice(0, 8)
    try {
      const { browser, userAgent } = await this.getBrowser()
      const result = await capturePage({
        browser,
        userAgent,
        crawl,
        page,
        robots: page.depth === 0 ? undefined : this.robotsFor(job),
        store: this.store,
        captureId,
        navTimeoutMs: job.settings.navTimeoutMs,
        isCancelled: async () => !(await isCrawlActive(this.db, crawl.id)),
      })
      kept = await completePage(this.db, this.id, job, result)
      this.log(`${result.error ? 'failed' : 'done'} ${page.url}${result.error ? `: ${result.error}` : ''}`)
    } catch (err) {
      if (!(err instanceof CrawlCancelled)) {
        // Something broke outside the page itself (e.g. the browser crashed).
        this.log(`error on ${page.url}: ${errorMessage(err)}`)
        kept = await completePage(this.db, this.id, job, {
          httpStatus: null,
          title: null,
          error: errorMessage(err),
          discoveredUrls: [],
          screenshots: [],
        })
      }
    }
    // Each capture writes its own files: drop ours if they weren't kept, or the
    // page's earlier ones (from before a refetch) now that ours replaced them.
    await this.removeCaptures(job, (file) => file.startsWith(`${page.id}-${captureId}-`) !== kept)
  }

  /**
   * Robots rules are stored on the crawl by its root page; parse them once per
   * crawl, and again if refetching the root page changed them.
   */
  private robotsFor({ crawl }: ClaimedJob) {
    const cached = this.robots.get(crawl.id)
    if (cached?.text !== crawl.robotsTxt) {
      this.robots.set(crawl.id, {
        text: crawl.robotsTxt,
        rules: crawl.robotsTxt ? parseRobots(crawl.robotsTxt) : undefined,
      })
    }
    return this.robots.get(crawl.id)!.rules
  }

  /** Relaunches Chromium if it has gone away (once, however many slots notice). */
  private async getBrowser() {
    const pending = this.browser
    const current = await pending?.catch(() => undefined)
    if (!current?.browser.isConnected() && this.browser === pending) {
      this.browser = launchBrowser()
    }
    return this.browser!
  }

  /** Delete the page's capture files that `remove` picks. */
  private async removeCaptures({ page, crawl }: ClaimedJob, remove: (file: string) => boolean) {
    const dir = `${crawl.id}/`
    try {
      const keys = await this.store.list(`${dir}${page.id}-`)
      await this.store.delete(keys.filter((key) => remove(key.slice(dir.length))))
    } catch (err) {
      // Leftover files only cost space; the page's screenshot rows are what count.
      this.log(`couldn't remove old captures of ${page.url}: ${errorMessage(err)}`)
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer)
        this.sleepers.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, ms)
      this.sleepers.add(wake)
    })
  }
}

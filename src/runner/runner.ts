import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
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
import { SCREENSHOT_DIR } from '#/server/paths'

export interface RunnerOptions {
  db: Db
  id?: string
  /** Pages this runner captures at once. Unset: follow the slots-per-runner setting. */
  concurrency?: number
  screenshotDir?: string
  /** How long an idle slot waits before looking for work again. */
  pollMs?: number
  heartbeatMs?: number
  log?: (message: string) => void
}

/**
 * Captures pages from the shared queue until stopped. Independent of the admin
 * server: start as many as you like against the same data directory.
 */
export class Runner {
  readonly id: string
  private readonly db: Db
  /** Set when the slot count was given explicitly rather than taken from settings. */
  private readonly pinnedConcurrency?: number
  private targetConcurrency = 0
  private readonly screenshotDir: string
  private readonly pollMs: number
  private readonly heartbeatMs: number
  private readonly log: (message: string) => void

  private browser?: Promise<{ browser: Browser; userAgent: string }>
  private readonly active = new Set<string>()
  private readonly robots = new Map<string, RobotsRules | undefined>()
  private readonly sleepers = new Set<() => void>()
  private readonly slots = new Map<number, Promise<void>>()
  private heartbeatTimer?: NodeJS.Timeout
  private stopping = false

  constructor(options: RunnerOptions) {
    this.db = options.db
    this.id = options.id ?? `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`
    this.pinnedConcurrency = options.concurrency
    this.screenshotDir = options.screenshotDir ?? SCREENSHOT_DIR
    this.pollMs = options.pollMs ?? 1000
    this.heartbeatMs = options.heartbeatMs ?? 15_000
    this.log = options.log ?? (() => {})
  }

  /** Pages this runner captures at once. */
  get concurrency() {
    return this.targetConcurrency
  }

  async start() {
    this.targetConcurrency = this.pinnedConcurrency ?? getRunnerSettings(this.db).slotsPerRunner
    registerRunner(this.db, {
      id: this.id,
      hostname: os.hostname(),
      pid: process.pid,
      concurrency: this.concurrency,
    })
    await this.getBrowser()
    this.beat()
    this.heartbeatTimer = setInterval(() => this.beat(), this.heartbeatMs)
    this.resize(this.targetConcurrency)
  }

  /** Stop claiming, let in-flight pages finish, then shut down. */
  async stop() {
    this.stopping = true
    for (const wake of this.sleepers) wake()
    await Promise.all(this.slots.values())
    clearInterval(this.heartbeatTimer)
    removeRunner(this.db, this.id)
    const browser = await this.browser?.catch(() => undefined)
    await browser?.browser.close().catch(() => {})
  }

  private beat() {
    try {
      if (this.pinnedConcurrency === undefined) {
        const { slotsPerRunner } = getRunnerSettings(this.db)
        if (slotsPerRunner !== this.targetConcurrency) {
          this.log(`slots ${this.targetConcurrency} -> ${slotsPerRunner}`)
          this.resize(slotsPerRunner)
        }
      }
      reapExpiredLeases(this.db)
      heartbeat(this.db, this.id, [...this.active], Date.now(), this.concurrency)
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
        job = claimNextPage(this.db, this.id)
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
    try {
      const { browser, userAgent } = await this.getBrowser()
      const result = await capturePage({
        browser,
        userAgent,
        crawl,
        page,
        robots: page.depth === 0 ? undefined : this.robotsFor(job),
        screenshotDir: this.screenshotDir,
        navTimeoutMs: job.settings.navTimeoutMs,
        isCancelled: () => !isCrawlActive(this.db, crawl.id),
      })
      kept = completePage(this.db, this.id, job, result)
      this.log(`${result.error ? 'failed' : 'done'} ${page.url}${result.error ? `: ${result.error}` : ''}`)
    } catch (err) {
      if (!(err instanceof CrawlCancelled)) {
        // Something broke outside the page itself (e.g. the browser crashed).
        this.log(`error on ${page.url}: ${errorMessage(err)}`)
        kept = completePage(this.db, this.id, job, {
          httpStatus: null,
          title: null,
          error: errorMessage(err),
          discoveredUrls: [],
          screenshots: [],
        })
      }
    }
    // If the lease was lost while the crawl is still going, another runner owns the
    // page now and is writing the same files, so only clean up after a cancel/delete.
    if (!kept && !isCrawlActive(this.db, crawl.id)) await this.removeCaptures(job)
  }

  /** Robots rules are stored on the crawl by its root page; parse them once per crawl. */
  private robotsFor({ crawl }: ClaimedJob) {
    if (!this.robots.has(crawl.id)) {
      this.robots.set(crawl.id, crawl.robotsTxt ? parseRobots(crawl.robotsTxt) : undefined)
    }
    return this.robots.get(crawl.id)
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

  /** Files captured for a page whose crawl was cancelled or deleted meanwhile. */
  private async removeCaptures({ page, crawl }: ClaimedJob) {
    const dir = path.join(this.screenshotDir, crawl.id)
    const files = await fs.readdir(dir).catch(() => [] as string[])
    await Promise.all(
      files
        .filter((f) => f.startsWith(`${page.id}-`))
        .map((f) => fs.rm(path.join(dir, f), { force: true })),
    )
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

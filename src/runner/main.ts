import { db } from '#/server/db/client'
import { Runner } from './runner'

/**
 * `pnpm runner`: capture pages from the shared queue until interrupted.
 * RUNNER_CONCURRENCY pins its slot count; otherwise it follows the settings page.
 */
const concurrency = process.env.RUNNER_CONCURRENCY ? Number(process.env.RUNNER_CONCURRENCY) : undefined
if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
  console.error('RUNNER_CONCURRENCY must be a positive integer')
  process.exit(1)
}

const runner = new Runner({
  db,
  id: process.env.RUNNER_ID || undefined,
  concurrency,
  log: (message) => console.log(`[runner ${runner.id}] ${message}`),
})

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1) // second Ctrl+C: don't wait for in-flight pages
    stopping = true
    console.log(`[runner ${runner.id}] stopping after in-flight pages (again to force)…`)
    runner.stop().then(
      () => process.exit(0),
      (err) => {
        console.error(err)
        process.exit(1)
      },
    )
  })
}

await runner.start()
console.log(`[runner ${runner.id}] started with ${runner.concurrency} slots`)

import { eq } from 'drizzle-orm'
import { DEFAULT_RUNNER_SETTINGS, runnerSettingsSchema, type RunnerSettings } from '#/lib/schemas'
import type { Db } from '../db/client'
import { settings } from '../db/schema'

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

/** The saved runner settings, with defaults for anything missing or no longer valid. */
export function getRunnerSettings(db: Db | Tx): RunnerSettings {
  const row = db.select().from(settings).where(eq(settings.key, 'runner')).get()
  const parsed = runnerSettingsSchema.safeParse(row?.value ?? {})
  return parsed.success ? parsed.data : DEFAULT_RUNNER_SETTINGS
}

export function saveRunnerSettings(db: Db, value: RunnerSettings) {
  const now = new Date()
  db.insert(settings)
    .values({ key: 'runner', value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
    .run()
}

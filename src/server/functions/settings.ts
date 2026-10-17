import { createServerFn } from '@tanstack/react-start'
import { runnerSettingsSchema } from '#/lib/schemas'
import { db } from '../db/client'
import { getRunnerSettings, saveRunnerSettings } from '../crawler/settings'

export const getSettings = createServerFn({ method: 'GET' }).handler(async () => {
  return getRunnerSettings(db)
})

export const saveSettings = createServerFn({ method: 'POST' })
  .validator(runnerSettingsSchema)
  .handler(async ({ data }) => {
    // Runners read these from the database: on every claim, and their slot count on each heartbeat.
    await saveRunnerSettings(db, data)
    return data
  })

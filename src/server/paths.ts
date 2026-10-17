import path from 'node:path'

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data')
/** Where screenshots go when they're stored on local disk (the default; see server/storage). */
export const SCREENSHOT_DIR = path.resolve(process.env.SCREENSHOT_DIR ?? path.join(DATA_DIR, 'screenshots'))
export const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/site_inspector'

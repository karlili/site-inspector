import path from 'node:path'

export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? 'data')
export const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots')
export const DATABASE_FILE = path.resolve(
  process.env.DATABASE_URL ?? path.join(DATA_DIR, 'site-inspector.db'),
)

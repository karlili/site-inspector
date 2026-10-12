import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { DATABASE_FILE } from '../paths'
import * as schema from './schema'

/** Each process (admin, every runner) opens its own connection to the shared file. */
export function openDb(file = DATABASE_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  // The admin and any number of runners write to this file; wait for the lock instead of failing.
  sqlite.pragma('busy_timeout = 5000')
  const db = drizzle(sqlite, { schema })
  // Apply pending migrations on boot so a fresh checkout just works.
  migrate(db, { migrationsFolder: path.resolve('drizzle') })
  return db
}

// Survive Vite HMR reloads without opening a new connection each time.
const globalForDb = globalThis as unknown as { __db?: Db }
export const db = (globalForDb.__db ??= openDb())
export type Db = ReturnType<typeof openDb>

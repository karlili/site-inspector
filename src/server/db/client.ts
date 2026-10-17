import path from 'node:path'
import pg from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { DATABASE_URL } from '../paths'
import * as schema from './schema'

/** Held while migrating, so processes starting at the same time don't race to create tables. */
const MIGRATION_LOCK_ID = 7_401_120_001

/** Each process (admin, every runner) keeps its own pool of connections to the shared database. */
export function openDb(url = DATABASE_URL) {
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_SIZE) || 10,
  })
  // A pooled connection dropping while idle (e.g. the server restarted) must not crash the process;
  // the pool replaces it on the next query.
  pool.on('error', (err) => console.error(`Database connection lost: ${err.message}`))
  return drizzle({ client: pool, schema })
}

export type Db = ReturnType<typeof openDb>

export async function closeDb(db: Db) {
  await db.$client.end()
}

/** Apply pending migrations from `drizzle/`, one process at a time. */
export async function migrateDb(url = DATABASE_URL) {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
    await migrate(drizzle({ client }), { migrationsFolder: path.resolve('drizzle') })
  } finally {
    // Ending the session releases the lock.
    await client.end()
  }
}

// Survive Vite HMR reloads without opening a new pool or migrating again each time.
const globalForDb = globalThis as unknown as { __db?: Db; __dbMigrated?: Promise<void> }
// Apply pending migrations on boot so a fresh database just works. If the database
// can't be reached, the next reload tries again.
await (globalForDb.__dbMigrated ??= migrateDb().catch((err) => {
  globalForDb.__dbMigrated = undefined
  throw err
}))
export const db = (globalForDb.__db ??= openDb())

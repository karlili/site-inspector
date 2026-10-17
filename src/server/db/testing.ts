import { randomUUID } from 'node:crypto'
import pg from 'pg'

/**
 * Point DATABASE_URL at a new, empty database for one test file, so test
 * files can run in parallel without seeing each other's rows. Call it before
 * anything imports the database client. The server comes from
 * TEST_DATABASE_URL, else DATABASE_URL, else a local Postgres. Returns a
 * function that drops the database again; close the pools using it first.
 */
export async function createTestDatabase(): Promise<() => Promise<void>> {
  const server =
    process.env.TEST_DATABASE_URL ||
    process.env.DATABASE_URL ||
    'postgres://postgres:postgres@localhost:5432/postgres'
  const name = `site_inspector_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`
  const admin = new pg.Client({ connectionString: server })
  try {
    await admin.connect()
  } catch (err) {
    const where = new URL(server)
    where.password = where.password && '***'
    throw new Error(
      `The tests need a Postgres server to create databases in; set TEST_DATABASE_URL (tried ${where}): ${(err as Error).message}`,
    )
  }
  try {
    await admin.query(`create database ${name}`)
  } finally {
    await admin.end()
  }
  const url = new URL(server)
  url.pathname = `/${name}`
  process.env.DATABASE_URL = url.toString()

  return async () => {
    const cleanup = new pg.Client({ connectionString: server })
    await cleanup.connect()
    try {
      await cleanup.query(`drop database if exists ${name} with (force)`)
    } finally {
      await cleanup.end()
    }
  }
}

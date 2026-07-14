import { afterEach, describe, expect, it, vi } from 'vitest'

// Uses a placeholder connection string, not a real one that gets connected
// to: pg.Pool never eagerly opens a connection on construction, only on the
// first query — so this exercises the "DATABASE_URL is set" success path
// without any real network I/O.
const PLACEHOLDER_DATABASE_URL = 'postgresql://user:password@localhost:5433/webhooks'

describe('pool', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL

  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl
    }
    vi.resetModules()
  })

  it('throws at import time when DATABASE_URL is not set', async () => {
    delete process.env.DATABASE_URL
    vi.resetModules()

    await expect(import('./pool.js')).rejects.toThrow('DATABASE_URL is not set')
  })

  it('exports a Pool constructed from DATABASE_URL when it is set', async () => {
    process.env.DATABASE_URL = PLACEHOLDER_DATABASE_URL
    vi.resetModules()

    const { pool } = await import('./pool.js')

    expect(pool).toBeDefined()
    expect(typeof pool.query).toBe('function')
    await pool.end()
  })
})

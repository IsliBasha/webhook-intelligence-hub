import { Pool } from 'pg'

// DATABASE_URL is the app's real Postgres connection string (see
// .env.example). Failing fast here — at import time, not on first query —
// means a misconfigured deployment never silently falls back to pg's
// default local-connection behavior; it refuses to start instead.
const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is not set')
}

// Singleton pool for the running app. Integration tests must NOT import
// this module — they construct their own isolated pg.Pool against
// TEST_DATABASE_URL (see src/storage/event-store.test.ts and
// src/routing/dead-letter.test.ts) so test runs never share a connection
// pool or lifecycle with production configuration.
export const pool = new Pool({ connectionString })

import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { EventStore } from '../storage/event-store.js'
import { DeadLetterQueue } from './dead-letter.js'

// Same local-only test fixture used by src/storage/event-store.test.ts —
// falls back to the standard docker-compose Postgres port (5432), not the
// app's real DATABASE_URL. Not a secret, so hardcoding the fallback is fine.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://user:password@localhost:5432/webhooks'

const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const store = new EventStore(pool)
const dlq = new DeadLetterQueue(pool)

const EVENT_ID = '77777777-7777-7777-7777-777777777777'

beforeEach(async () => {
  await pool.query('TRUNCATE TABLE dead_letter_queue, webhook_events')
  await store.save({
    id: EVENT_ID,
    provider: 'stripe',
    event_type: 'charge.failed',
    raw_payload: { id: 'evt_1AbCdE' },
    status: 'failed',
  })
})

afterAll(async () => {
  await pool.end()
})

describe('DeadLetterQueue (integration, real Postgres)', () => {
  describe('move', () => {
    it('inserts a row referencing the event with the given error message', async () => {
      await dlq.move(EVENT_ID, 'classification exhausted retries')

      const result = await pool.query('SELECT * FROM dead_letter_queue WHERE event_id = $1', [
        EVENT_ID,
      ])
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].last_error).toBe('classification exhausted retries')
      expect(result.rows[0].failed_at).not.toBeNull()
    })
  })

  describe('listAll', () => {
    it('returns entries ordered by failed_at descending', async () => {
      await dlq.move(EVENT_ID, 'first failure')
      // Real-clock ordering test: needs the two failed_at timestamps to
      // differ so DESC ordering is actually exercised, not coincidental.
      await new Promise((resolve) => setTimeout(resolve, 10))
      await dlq.move(EVENT_ID, 'second failure')

      const entries = await dlq.listAll()

      expect(entries).toHaveLength(2)
      expect(entries[0].last_error).toBe('second failure')
      expect(entries[1].last_error).toBe('first failure')
    })
  })

  describe('retry', () => {
    it('resets the webhook_events row to pending/attempts=0, clears last_error, and keeps the DLQ row as history', async () => {
      await pool.query(
        "UPDATE webhook_events SET attempts = 3, last_error = 'previous failure' WHERE id = $1",
        [EVENT_ID]
      )
      await dlq.move(EVENT_ID, 'boom')
      const [entry] = await dlq.listAll()

      await dlq.retry(entry.id)

      const eventResult = await pool.query('SELECT * FROM webhook_events WHERE id = $1', [
        EVENT_ID,
      ])
      expect(eventResult.rows[0].status).toBe('pending')
      expect(eventResult.rows[0].attempts).toBe(0)
      expect(eventResult.rows[0].last_error).toBeNull()

      const dlqResult = await pool.query('SELECT * FROM dead_letter_queue WHERE id = $1', [
        entry.id,
      ])
      expect(dlqResult.rows).toHaveLength(1)
    })

    it('is a no-op when the dlqId does not exist', async () => {
      await expect(
        dlq.retry('00000000-0000-0000-0000-000000000000')
      ).resolves.toBeUndefined()

      const eventResult = await pool.query('SELECT * FROM webhook_events WHERE id = $1', [
        EVENT_ID,
      ])
      expect(eventResult.rows[0].status).toBe('failed') // untouched
    })
  })
})

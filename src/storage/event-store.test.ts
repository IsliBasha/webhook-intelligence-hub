import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { EventStore } from './event-store.js'
import type { WebhookEvent } from './event-store.js'

// TEST_DATABASE_URL points at a dedicated Postgres instance for integration
// tests, never the app's real DATABASE_URL. Falls back to the standard
// docker-compose port (5432) so `docker-compose up -d postgres && npm test`
// works out of the box; override TEST_DATABASE_URL if running a test
// instance on a different port (e.g. to avoid clashing with another local
// Postgres already bound to 5432). Not a secret, so hardcoding the fallback
// is fine.
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgresql://user:password@localhost:5432/webhooks'

const pool = new Pool({ connectionString: TEST_DATABASE_URL })
const store = new EventStore(pool)

type SaveInput = Omit<WebhookEvent, 'created_at' | 'attempts'>

function makeEvent(overrides: Partial<SaveInput> = {}): SaveInput {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    provider: 'github',
    event_type: 'push',
    raw_payload: { hello: 'world' },
    status: 'pending',
    ...overrides,
  }
}

beforeEach(async () => {
  // Both tables truncated together satisfies the dead_letter_queue ->
  // webhook_events foreign key without needing CASCADE, and keeps each
  // test isolated from the last.
  await pool.query('TRUNCATE TABLE dead_letter_queue, webhook_events')
})

afterAll(async () => {
  await pool.end()
})

describe('EventStore (integration, real Postgres)', () => {
  describe('save', () => {
    it('inserts a new event row with the given fields', async () => {
      await store.save(makeEvent())

      const result = await pool.query('SELECT * FROM webhook_events WHERE id = $1', [
        '11111111-1111-1111-1111-111111111111',
      ])

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].provider).toBe('github')
      expect(result.rows[0].event_type).toBe('push')
      expect(result.rows[0].raw_payload).toEqual({ hello: 'world' })
      expect(result.rows[0].status).toBe('pending')
      expect(result.rows[0].attempts).toBe(0)
    })

    it('does not insert a duplicate row when saved twice with the same id (idempotency)', async () => {
      await store.save(makeEvent())
      // Simulates a redelivery: same derived id, but a different payload
      // would arrive if this were a genuine duplicate insert instead of a
      // no-op — asserting the *first* save's data survives proves the
      // ON CONFLICT (id) DO UPDATE SET id = id path is a true no-op (only
      // exists to make RETURNING fire on conflict), not a real overwrite.
      await store.save(makeEvent({ event_type: 'pull_request', raw_payload: { changed: true } }))

      const result = await pool.query('SELECT * FROM webhook_events WHERE id = $1', [
        '11111111-1111-1111-1111-111111111111',
      ])

      expect(result.rows).toHaveLength(1)
      expect(result.rows[0].event_type).toBe('push')
      expect(result.rows[0].raw_payload).toEqual({ hello: 'world' })
    })

    it('returns isNew: true for a fresh insert and isNew: false for a duplicate id', async () => {
      const first = await store.save(makeEvent())
      const second = await store.save(makeEvent({ event_type: 'pull_request' }))

      expect(first.isNew).toBe(true)
      expect(second.isNew).toBe(false)
    })

    it('returns the EXISTING row\'s status on conflict, not "pending" from the redelivery attempt', async () => {
      await store.save(makeEvent())
      await store.markProcessed('11111111-1111-1111-1111-111111111111', { urgency: 'high' })

      // A redelivery always attempts to save with status: 'pending' (see
      // pipeline.ts) — the point of this test is that the row's real
      // current status ('processed') comes back, not the attempted value,
      // so callers can tell a genuinely-already-handled redelivery apart
      // from one that's still stuck mid-flight.
      const redelivery = await store.save(makeEvent())

      expect(redelivery.isNew).toBe(false)
      expect(redelivery.status).toBe('processed')
    })

    it('returns status: "pending" on conflict when the original save never finished processing (crash recovery case)', async () => {
      await store.save(makeEvent())
      // No markProcessed/markFailed call — simulates a crash between the
      // original save() and classification completing.

      const redelivery = await store.save(makeEvent())

      expect(redelivery.isNew).toBe(false)
      expect(redelivery.status).toBe('pending')
    })

    it('returns status: "failed" on conflict when the original attempt already failed', async () => {
      await store.save(makeEvent())
      await store.markFailed('11111111-1111-1111-1111-111111111111', 'transient error')

      const redelivery = await store.save(makeEvent())

      expect(redelivery.isNew).toBe(false)
      expect(redelivery.status).toBe('failed')
    })

    it('does not change any other column when conflicting (the ON CONFLICT update is a true no-op)', async () => {
      await store.save(makeEvent())
      await store.markProcessed('11111111-1111-1111-1111-111111111111', { urgency: 'high' })

      await store.save(makeEvent({ event_type: 'pull_request', raw_payload: { changed: true } }))

      const result = await pool.query('SELECT * FROM webhook_events WHERE id = $1', [
        '11111111-1111-1111-1111-111111111111',
      ])
      expect(result.rows[0].event_type).toBe('push')
      expect(result.rows[0].raw_payload).toEqual({ hello: 'world' })
      expect(result.rows[0].classified).toEqual({ urgency: 'high' })
      expect(result.rows[0].status).toBe('processed')
    })
  })

  describe('markProcessed', () => {
    it('stores the classification, sets status to processed, and stamps processed_at atomically', async () => {
      await store.save(makeEvent())

      await store.markProcessed('11111111-1111-1111-1111-111111111111', { urgency: 'high' })

      const result = await pool.query('SELECT * FROM webhook_events WHERE id = $1', [
        '11111111-1111-1111-1111-111111111111',
      ])
      expect(result.rows[0].classified).toEqual({ urgency: 'high' })
      expect(result.rows[0].status).toBe('processed')
      expect(result.rows[0].processed_at).not.toBeNull()
    })
  })

  describe('markFailed', () => {
    it('sets status to failed, increments attempts, and records last_error on every call', async () => {
      await store.save(makeEvent())

      await store.markFailed('11111111-1111-1111-1111-111111111111', 'first failure')
      await store.markFailed('11111111-1111-1111-1111-111111111111', 'second failure')

      const result = await pool.query('SELECT * FROM webhook_events WHERE id = $1', [
        '11111111-1111-1111-1111-111111111111',
      ])
      expect(result.rows[0].status).toBe('failed')
      expect(result.rows[0].attempts).toBe(2)
      expect(result.rows[0].last_error).toBe('second failure')
      // classified stays untouched by markFailed — no shape ambiguity with
      // a genuine ClassifiedEvent, unlike stashing the error there would be.
      expect(result.rows[0].classified).toBeNull()
    })

    it('returns the new attempts count after incrementing', async () => {
      await store.save(makeEvent())

      const first = await store.markFailed('11111111-1111-1111-1111-111111111111', 'e1')
      const second = await store.markFailed('11111111-1111-1111-1111-111111111111', 'e2')

      expect(first.attempts).toBe(1)
      expect(second.attempts).toBe(2)
    })

    it('schedules next_retry_at with exponential backoff (roughly 1s, 2s, 4s, 8s after each successive failure)', async () => {
      await store.save(makeEvent())
      const expectedDelaysSeconds = [1, 2, 4, 8]

      for (const expectedSeconds of expectedDelaysSeconds) {
        const before = Date.now()
        await store.markFailed('11111111-1111-1111-1111-111111111111', 'transient error')

        const result = await pool.query('SELECT next_retry_at FROM webhook_events WHERE id = $1', [
          '11111111-1111-1111-1111-111111111111',
        ])
        const actualDelaySeconds = (new Date(result.rows[0].next_retry_at).getTime() - before) / 1000

        // Wide tolerance band: this only needs to prove the backoff
        // roughly doubles each time, not exact timing, since Postgres's
        // now() and this test's clock aren't perfectly synchronized.
        expect(actualDelaySeconds).toBeGreaterThan(expectedSeconds - 1)
        expect(actualDelaySeconds).toBeLessThan(expectedSeconds + 2)
      }
    })

    it('caps backoff at 16s once the doubling sequence would exceed it', async () => {
      await store.save(makeEvent())
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await store.markFailed('11111111-1111-1111-1111-111111111111', 'transient error')
      }

      const before = Date.now()
      await store.markFailed('11111111-1111-1111-1111-111111111111', 'fifth failure')

      const result = await pool.query('SELECT next_retry_at FROM webhook_events WHERE id = $1', [
        '11111111-1111-1111-1111-111111111111',
      ])
      const actualDelaySeconds = (new Date(result.rows[0].next_retry_at).getTime() - before) / 1000

      expect(actualDelaySeconds).toBeGreaterThan(15)
      expect(actualDelaySeconds).toBeLessThan(18)
    })
  })

  describe('recordRoutingError', () => {
    it('sets last_error without changing status or attempts (distinct from markFailed)', async () => {
      await store.save(makeEvent())
      await store.markProcessed('11111111-1111-1111-1111-111111111111', { urgency: 'critical' })

      await store.recordRoutingError('11111111-1111-1111-1111-111111111111', 'Slack: 500')

      const result = await pool.query('SELECT * FROM webhook_events WHERE id = $1', [
        '11111111-1111-1111-1111-111111111111',
      ])
      expect(result.rows[0].last_error).toBe('Slack: 500')
      expect(result.rows[0].status).toBe('processed')
      expect(result.rows[0].attempts).toBe(0)
      expect(result.rows[0].classified).toEqual({ urgency: 'critical' })
    })
  })

  describe('claimForRetry', () => {
    // Backdating next_retry_at after markFailed isolates the
    // attempts-threshold filter under test here from the backoff-timing
    // filter, which has its own dedicated tests below — otherwise the real
    // 1s+ backoff markFailed schedules would make "underThreshold" not-yet-
    // due and incorrectly excluded.
    async function makeRowDueNow(id: string): Promise<void> {
      await pool.query(`UPDATE webhook_events SET next_retry_at = now() - interval '1 minute' WHERE id = $1`, [
        id,
      ])
    }

    it('returns only failed rows with attempts under the given threshold', async () => {
      const underThreshold = '22222222-2222-2222-2222-222222222222'
      const overThreshold = '33333333-3333-3333-3333-333333333333'
      const stillPending = '44444444-4444-4444-4444-444444444444'
      const alreadyProcessed = '55555555-5555-5555-5555-555555555555'

      await store.save(makeEvent({ id: underThreshold }))
      await store.markFailed(underThreshold, 'transient error')
      await makeRowDueNow(underThreshold)

      await store.save(makeEvent({ id: overThreshold }))
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await store.markFailed(overThreshold, 'transient error')
      }
      await makeRowDueNow(overThreshold)

      await store.save(makeEvent({ id: stillPending }))

      await store.save(makeEvent({ id: alreadyProcessed }))
      await store.markProcessed(alreadyProcessed, { urgency: 'low' })

      const results = await store.claimForRetry(5)
      const ids = results.map((row) => row.id)

      expect(ids).toContain(underThreshold)
      expect(ids).not.toContain(overThreshold)
      expect(ids).not.toContain(stillPending)
      expect(ids).not.toContain(alreadyProcessed)
    })

    it('defaults maxAttempts to 5 when not provided', async () => {
      const id = '66666666-6666-6666-6666-666666666666'
      await store.save(makeEvent({ id }))
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await store.markFailed(id, 'transient error')
      }
      await makeRowDueNow(id)

      const results = await store.claimForRetry()

      expect(results.map((row) => row.id)).toContain(id)
    })

    it('excludes failed rows whose next_retry_at is still in the future', async () => {
      const notYetDue = '77777777-aaaa-7777-aaaa-777777777777'
      await store.save(makeEvent({ id: notYetDue }))
      await store.markFailed(notYetDue, 'transient error') // schedules ~1s ahead by default backoff

      const results = await store.claimForRetry(5)

      expect(results.map((row) => row.id)).not.toContain(notYetDue)
    })

    it('includes failed rows once next_retry_at has passed', async () => {
      const nowDue = '88888888-aaaa-8888-aaaa-888888888888'
      await store.save(makeEvent({ id: nowDue }))
      await store.markFailed(nowDue, 'transient error')
      await makeRowDueNow(nowDue)

      const results = await store.claimForRetry(5)

      expect(results.map((row) => row.id)).toContain(nowDue)
    })

    it('is an atomic claim, not a passive read: a second immediate call does not return the same row again', async () => {
      // This is the core fix for the overlapping-sweep race: claiming a row
      // pushes next_retry_at into the future as a lease, so a concurrent or
      // immediately-following claimForRetry call can't pick up the same row
      // — it fails the next_retry_at <= now() filter until the lease
      // expires. Two real, sequential DB calls (not a mock) are the only
      // way to prove the claim actually mutates state, not just reads it.
      const id = '99999999-aaaa-9999-aaaa-999999999999'
      await store.save(makeEvent({ id }))
      await store.markFailed(id, 'transient error')
      await makeRowDueNow(id)

      const firstClaim = await store.claimForRetry(5)
      const secondClaim = await store.claimForRetry(5)

      expect(firstClaim.map((row) => row.id)).toContain(id)
      expect(secondClaim.map((row) => row.id)).not.toContain(id)
    })

    it('sets next_retry_at into the future (a lease) on claim, so a crashed retry becomes eligible again after it expires', async () => {
      const id = '11111111-bbbb-1111-bbbb-111111111111'
      await store.save(makeEvent({ id }))
      await store.markFailed(id, 'transient error')
      await makeRowDueNow(id)

      const before = Date.now()
      await store.claimForRetry(5)

      const result = await pool.query('SELECT next_retry_at FROM webhook_events WHERE id = $1', [id])
      const leaseSeconds = (new Date(result.rows[0].next_retry_at).getTime() - before) / 1000
      // Long enough to comfortably outlast a normal classify+route call,
      // short enough that a crashed claim self-heals within a bounded time
      // instead of needing manual intervention.
      expect(leaseSeconds).toBeGreaterThan(60)
    })
  })
})

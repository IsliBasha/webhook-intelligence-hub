import type { Pool } from 'pg'

export const MAX_RETRY_ATTEMPTS = 5

// How long a claimForRetry() lease holds a row before it's considered
// abandoned and becomes claimable again — comfortably longer than a normal
// classify+route call, short enough that a crashed claim self-heals within
// a bounded time instead of needing manual intervention.
const CLAIM_LEASE_SECONDS = 300

export interface WebhookEvent {
  id: string
  provider: string
  event_type: string
  raw_payload: unknown
  classified?: unknown
  last_error?: string | null
  status: 'pending' | 'processed' | 'failed'
  attempts: number
  created_at: Date
  processed_at?: Date
  next_retry_at?: Date
}

export class EventStore {
  constructor(private readonly pool: Pool) {}

  // `id` is derived deterministically from the provider's own delivery id
  // (see src/storage/idempotency.ts), so a redelivered webhook resolves to
  // the same row here. This used to be a plain ON CONFLICT DO NOTHING, but
  // that can't report anything about the *existing* row on conflict — a
  // caller could only learn "this id already exists", not whether it was
  // ever actually finished. `DO UPDATE SET id = webhook_events.id` is a
  // true no-op (nothing changes) that exists purely to make RETURNING fire
  // on the conflicting row too, and `xmax = 0` is the standard Postgres
  // idiom for telling an insert apart from an update in that RETURNING
  // clause. Returning `status` lets pipeline.ts distinguish a genuinely
  // already-processed redelivery (safe to skip) from one whose original
  // attempt crashed mid-flight or was reset by DeadLetterQueue.retry()
  // (status 'pending'/'failed' — must still be reprocessed, or it would be
  // stranded forever with no automated recovery path).
  async save(
    event: Omit<WebhookEvent, 'created_at' | 'attempts'>
  ): Promise<{ isNew: boolean; status: WebhookEvent['status'] }> {
    const result = await this.pool.query<{ status: WebhookEvent['status']; is_new: boolean }>(
      `INSERT INTO webhook_events (id, provider, event_type, raw_payload, classified, status)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET id = webhook_events.id
       RETURNING status, (xmax = 0) AS is_new`,
      [
        event.id,
        event.provider,
        event.event_type,
        JSON.stringify(event.raw_payload),
        event.classified === undefined ? null : JSON.stringify(event.classified),
        event.status,
      ]
    )
    return { isNew: result.rows[0].is_new, status: result.rows[0].status }
  }

  // One atomic UPDATE rather than a separate "save classification" +
  // "mark processed" pair — a crash between two non-atomic writes could
  // otherwise leave a row with `classified` populated but `status` still
  // 'pending' forever, since claimForRetry only looks at status = 'failed'
  // and nothing else in this codebase watches for that shape.
  async markProcessed(id: string, classified: unknown): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_events
       SET classified = $1, status = 'processed', processed_at = now()
       WHERE id = $2`,
      [JSON.stringify(classified), id]
    )
  }

  // Schedules the next retry with exponential backoff — 1s, 2s, 4s, 8s,
  // capped at 16s (matches the blueprint's 1->2->4->8->16 sequence) — in
  // the same atomic UPDATE that records the failure. `attempts` on the
  // right-hand side of the LEAST(...) expression refers to the row's value
  // *before* this statement's own increment (Postgres evaluates all SET
  // expressions against the pre-update row), so the first failure
  // (old attempts=0) schedules a 1s backoff, not a 2s one. Returns the new
  // attempts count so callers (pipeline.ts) can move the event to the DLQ
  // immediately once MAX_RETRY_ATTEMPTS is reached, instead of leaving it
  // stuck as 'failed' with no path back to visibility.
  async markFailed(id: string, error: string): Promise<{ attempts: number }> {
    const result = await this.pool.query<{ attempts: number }>(
      `UPDATE webhook_events
       SET status = 'failed',
           attempts = attempts + 1,
           last_error = $2,
           next_retry_at = now() + (LEAST(POWER(2, attempts), 16) * interval '1 second')
       WHERE id = $1
       RETURNING attempts`,
      [id, error]
    )
    return { attempts: result.rows[0].attempts }
  }

  // Distinct from markFailed: a routing (Slack/Notion) delivery failure
  // happens *after* the event was already classified and persisted, so it
  // must not flip status back to 'failed' or bump attempts — those mean
  // "classification needs retry", which isn't what happened here. This only
  // records the failure reason so it's visible instead of silently dropped.
  async recordRoutingError(id: string, error: string): Promise<void> {
    await this.pool.query(`UPDATE webhook_events SET last_error = $2 WHERE id = $1`, [id, error])
  }

  // Deliberately not a plain SELECT: the retry scheduler polls every 5s
  // (see pipeline.ts's startRetryScheduler), and a slow reprocess (a real
  // Claude/Slack/Notion call) can still be in flight when the next tick
  // fires. A passive read would let two overlapping sweeps — or, later,
  // two app instances — claim and reprocess the same row concurrently:
  // double API calls, an over-incremented attempts count racing the
  // backoff schedule, or worse, a slow straggler's markFailed silently
  // regressing a row a faster concurrent call already marked 'processed'.
  //
  // This claims rows atomically instead: FOR UPDATE SKIP LOCKED inside the
  // subquery means a second concurrent claim can never select a row this
  // one is already touching, and pushing next_retry_at out by
  // CLAIM_LEASE_SECONDS is a lease — if this process crashes after
  // claiming but before calling markFailed/markProcessed, the row simply
  // becomes eligible again once the lease expires, with no manual
  // intervention needed, instead of being stuck as 'failed' forever.
  async claimForRetry(maxAttempts: number = MAX_RETRY_ATTEMPTS): Promise<WebhookEvent[]> {
    const result = await this.pool.query<WebhookEvent>(
      `UPDATE webhook_events
       SET next_retry_at = now() + (${CLAIM_LEASE_SECONDS} * interval '1 second')
       WHERE id IN (
         SELECT id FROM webhook_events
         WHERE status = 'failed' AND attempts < $1 AND next_retry_at <= now()
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [maxAttempts]
    )
    return result.rows
  }
}

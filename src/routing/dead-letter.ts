import type { Pool } from 'pg'

export interface DeadLetterEntry {
  id: string
  event_id: string
  last_error: string | null
  failed_at: Date
}

export class DeadLetterQueue {
  constructor(private readonly pool: Pool) {}

  // `id` is not supplied — dead_letter_queue.id defaults to
  // gen_random_uuid() per migrations/001_initial.sql, so every move() call
  // creates a fresh DLQ history row even if the same event is moved more
  // than once (see retry() below for why old rows are kept, not deleted).
  async move(eventId: string, error: string): Promise<void> {
    await this.pool.query(`INSERT INTO dead_letter_queue (event_id, last_error) VALUES ($1, $2)`, [
      eventId,
      error,
    ])
  }

  async listAll(): Promise<DeadLetterEntry[]> {
    const result = await this.pool.query<DeadLetterEntry>(
      `SELECT * FROM dead_letter_queue ORDER BY failed_at DESC`
    )
    return result.rows
  }

  // Resets the originating webhook_events row to 'pending' with attempts
  // reset to 0 so it is picked up fresh by the normal processing path.
  // last_error is cleared too — otherwise a retried row would sit at
  // status='pending' while still carrying the previous failure's message,
  // indistinguishable from a fresh unprocessed event to anything reading it.
  //
  // The dead_letter_queue row is intentionally left in place rather than
  // deleted: it's the audit trail of "this event failed hard enough to be
  // dead-lettered", and a future dashboard/on-call review benefits from
  // seeing that history even after a successful retry. If the retried
  // event fails again, move() above appends a new row instead of
  // overwriting this one, so the queue reads as a timeline rather than a
  // single mutable "current status" per event.
  async retry(dlqId: string): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_events
       SET status = 'pending', attempts = 0, last_error = NULL
       WHERE id = (SELECT event_id FROM dead_letter_queue WHERE id = $1)`,
      [dlqId]
    )
  }
}

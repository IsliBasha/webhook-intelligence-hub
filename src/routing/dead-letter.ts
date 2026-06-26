import type { Pool } from 'pg'

export class DeadLetterQueue {
  constructor(private readonly pool: Pool) {}

  async move(eventId: string, error: string): Promise<void> {
    // TODO P3.3: INSERT into dead_letter_queue
    void eventId; void error; void this.pool
    throw new Error('Not implemented')
  }

  async listAll(): Promise<unknown[]> { throw new Error('Not implemented') }
  async retry(dlqId: string): Promise<void> { void dlqId; throw new Error('Not implemented') }
}

import type { Pool } from 'pg'

export interface WebhookEvent {
  id: string
  provider: string
  event_type: string
  raw_payload: unknown
  classified?: unknown
  status: 'pending' | 'processed' | 'failed'
  attempts: number
  created_at: Date
  processed_at?: Date
}

export class EventStore {
  constructor(private readonly pool: Pool) {}

  async save(event: Omit<WebhookEvent, 'created_at' | 'attempts'>): Promise<void> {
    // TODO P3.3: INSERT ... ON CONFLICT (id) DO NOTHING
    void event; void this.pool
    throw new Error('Not implemented')
  }

  async markProcessed(id: string): Promise<void> { void id; throw new Error('Not implemented') }
  async markFailed(id: string, error: string): Promise<void> { void id; void error; throw new Error('Not implemented') }
  async getForRetry(maxAttempts = 5): Promise<WebhookEvent[]> { void maxAttempts; throw new Error('Not implemented') }
}

import type { WebhookEvent } from '../storage/event-store.js'

export interface RetryEventSource {
  claimForRetry(maxAttempts?: number): Promise<WebhookEvent[]>
}

export type ReprocessFn = (
  id: string,
  provider: string,
  eventType: string,
  rawPayload: unknown
) => Promise<void>

export interface RetryQueueResult {
  attempted: number
  failed: number
}

// One sweep of the retry queue: atomically claim events whose backoff has
// elapsed (EventStore.claimForRetry filters status='failed' AND
// next_retry_at <= now(), then leases each claimed row by pushing
// next_retry_at forward — see its own doc comment for why) and reprocess
// each through the same classify -> store -> route path a first attempt
// uses (classifyStoreAndRoute in pipeline.ts). Runs the batch concurrently
// via allSettled rather than sequentially: one event's reprocess failure
// must not block the others in this sweep, and the atomic claim already
// means there's no shared row for concurrent reprocessing to race on.
export async function processRetryQueue(
  eventStore: RetryEventSource,
  reprocess: ReprocessFn,
  maxAttempts?: number
): Promise<RetryQueueResult> {
  const eligible = await eventStore.claimForRetry(maxAttempts)

  const results = await Promise.allSettled(
    eligible.map((event) => reprocess(event.id, event.provider, event.event_type, event.raw_payload))
  )
  const failed = results.filter((result) => result.status === 'rejected').length

  return { attempted: eligible.length, failed }
}

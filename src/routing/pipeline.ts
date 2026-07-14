/**
 * Seam for the post-verification pipeline: verify (caller) -> classify ->
 * store -> route. A single entry point so each stage only needs to fill in
 * this function instead of touching server.ts again.
 *
 * Headers are threaded through (not just provider/rawBody) because the
 * provider-supplied delivery ID for idempotency lives there:
 * X-GitHub-Delivery, X-Shopify-Webhook-Id, or the Stripe event body's own id.
 */
import { classifyEvent, ClassificationError } from '../processing/classifier.js'
import { deriveEventId } from '../storage/idempotency.js'
import { EventStore, MAX_RETRY_ATTEMPTS } from '../storage/event-store.js'
import { pool } from '../storage/pool.js'
import { firstHeaderValue } from '../providers/header-utils.js'
import type { WebhookHeaders } from '../providers/header-utils.js'
import { safeJsonParse } from '../providers/safe-json.js'
import { routeEvent } from './router.js'
import { buildRouterDeps } from './router-deps.js'
import { DeadLetterQueue } from './dead-letter.js'
import { processRetryQueue } from './retry-scheduler.js'

const eventStore = new EventStore(pool)
const deadLetterQueue = new DeadLetterQueue(pool)
const routerDeps = buildRouterDeps(eventStore)

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

function deriveEventType(provider: string, headers: WebhookHeaders, rawBody: Buffer): string {
  if (provider === 'github') {
    return nonEmpty(firstHeaderValue(headers['x-github-event'])) ?? 'unknown'
  }
  if (provider === 'shopify') {
    return nonEmpty(firstHeaderValue(headers['x-shopify-topic'])) ?? 'unknown'
  }
  if (provider === 'stripe') {
    return extractStripeEventType(rawBody) ?? 'unknown'
  }
  return 'unknown'
}

function extractStripeEventType(rawBody: Buffer): string | undefined {
  const parsed = safeJsonParse(rawBody)
  if (parsed !== null && typeof parsed === 'object' && 'type' in parsed) {
    const type = (parsed as { type: unknown }).type
    return typeof type === 'string' ? nonEmpty(type) : undefined
  }
  return undefined
}

// Shared by the fresh-webhook path below and the retry scheduler
// (retry-scheduler.ts), so a retried event goes through exactly the same
// classify -> store -> route sequence as a first attempt instead of a
// second, drifting implementation. On a repeat ClassificationError, moves
// the event to the DLQ once MAX_RETRY_ATTEMPTS is reached — otherwise it
// would sit as status='failed' forever, since claimForRetry() stops
// returning it past that threshold with no other path to visibility.
export async function classifyStoreAndRoute(
  id: string,
  provider: string,
  eventType: string,
  rawPayload: unknown
): Promise<void> {
  try {
    const classified = await classifyEvent(provider, eventType, rawPayload)
    await eventStore.markProcessed(id, classified)
    // Fire-and-record, not fire-and-forget: routeEvent internally catches
    // and records per-channel failures (see router.ts), so awaiting it here
    // only waits for that bookkeeping — it never rejects and therefore
    // never turns a Slack/Notion outage into a webhook-delivery failure.
    await routeEvent(id, provider, eventType, classified, routerDeps)
  } catch (err) {
    if (!(err instanceof ClassificationError)) {
      throw err
    }
    // A classification failure is an expected, handled outcome (bad model
    // output, transient API error, etc.) — not a server error. It must not
    // propagate to server.ts, whose try/catch exists for genuinely
    // unexpected failures.
    const { attempts } = await eventStore.markFailed(id, err.message)
    if (attempts >= MAX_RETRY_ATTEMPTS) {
      await deadLetterQueue.move(id, err.message)
    }
  }
}

export async function handleVerifiedWebhook(
  provider: string,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>
): Promise<void> {
  const eventType = deriveEventType(provider, headers, rawBody)
  const id = deriveEventId(provider, headers, rawBody)
  const rawPayload: unknown = JSON.parse(rawBody.toString('utf8'))

  // Persisted before classification is attempted: a crash or classification
  // failure below must never lose the event outright. This also preserves
  // ack ordering — server.ts awaits this whole function before sending 200,
  // so the raw event is durably stored before the client ever sees success.
  const { isNew, status } = await eventStore.save({
    id,
    provider,
    event_type: eventType,
    raw_payload: rawPayload,
    status: 'pending',
  })
  if (!isNew && status === 'processed') {
    // Redelivery of an event this service has already fully handled (id is
    // derived deterministically from the provider's own delivery id — see
    // storage/idempotency.ts). Reprocessing here would burn a redundant
    // Claude API call and, for critical/high events, re-notify Slack/Notion
    // for the same event. Acking 200 is still correct: this service does
    // have the event.
    //
    // Deliberately NOT skipping on status 'pending' or 'failed': that would
    // mean an event whose original attempt crashed between save() and
    // markProcessed/markFailed (status stuck at 'pending'), or one just
    // reset by DeadLetterQueue.retry() (also 'pending'), gets permanently
    // stranded the moment a redelivery arrives — claimForRetry only looks
    // at 'failed' rows, so a stuck 'pending' row would otherwise have no
    // path back to being processed at all.
    //
    // Known accepted tradeoff: this reopens a narrower race than the one
    // above. Two *genuinely concurrent* deliveries of the same not-yet-
    // finished event (not a later redelivery, but literally overlapping
    // in-flight requests) will both see status 'pending' and both proceed
    // to classifyStoreAndRoute — a duplicate Claude call and, for
    // critical/high events, a duplicate Slack/Notion notification. There's
    // no advisory lock or in-flight marker serializing same-id requests.
    // This is bounded (both writers converge on the same final 'processed'
    // state, no corruption) and requires true concurrency rather than
    // ordinary provider-retry behavior, so it's accepted rather than
    // fixed here — closing it would need a Postgres advisory lock held for
    // the whole classify+route duration, which requires a dedicated
    // checked-out pool client rather than pool.query()'s per-call
    // connection, a meaningful complexity jump for a rare, self-correcting
    // case.
    return
  }

  await classifyStoreAndRoute(id, provider, eventType, rawPayload)
}

const RETRY_POLL_INTERVAL_MS = 5000

// Started once from index.ts at process startup (not imported as a side
// effect of this module, so tests that import pipeline.ts never
// accidentally spin up a background timer). Matches the blueprint's
// 5-second poll cadence.
export function startRetryScheduler(): NodeJS.Timeout {
  // claimForRetry's atomic lease already makes overlapping sweeps *safe*
  // (a still-in-flight row can't be claimed twice), but skipping a tick
  // while the previous sweep hasn't finished avoids the wasted claim
  // query/round-trip entirely in the common case — a real Claude/Slack/
  // Notion call can easily outlast one 5s interval.
  let sweepInFlight = false
  return setInterval(() => {
    if (sweepInFlight) {
      return
    }
    sweepInFlight = true
    processRetryQueue(eventStore, classifyStoreAndRoute)
      .catch(() => {
        // processRetryQueue only rejects here if the claimForRetry read
        // itself throws (e.g. a transient Postgres blip) — individual
        // reprocess failures are already caught and counted internally via
        // Promise.allSettled. A failed sweep just means this poll is
        // skipped; the next interval tries again.
      })
      .finally(() => {
        sweepInFlight = false
      })
  }, RETRY_POLL_INTERVAL_MS)
}

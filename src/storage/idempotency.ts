import { createHash } from 'node:crypto'
import { v5 as uuidv5 } from 'uuid'
import { firstHeaderValue } from '../providers/header-utils.js'
import type { WebhookHeaders } from '../providers/header-utils.js'
import { safeJsonParse } from '../providers/safe-json.js'

// Fixed, hardcoded namespace UUID for uuidv5 — generated once via
// `node -e "console.log(require('crypto').randomUUID())"` and frozen here.
// This must NEVER be regenerated: uuidv5(name, namespace) is only
// deterministic across process restarts (and across every environment that
// runs this code) if the namespace itself never changes. A fresh namespace
// per call/deploy would make identical redeliveries derive different ids,
// defeating the whole point of ON CONFLICT (id) DO NOTHING idempotency.
const NAMESPACE = 'fbf0bf8a-710c-46f4-8685-081950890826'

/**
 * Derives a deterministic UUID for a webhook delivery so that redelivering
 * the same event (same provider delivery id) produces the same row id and
 * `ON CONFLICT (id) DO NOTHING` actually dedupes it, instead of a fresh
 * random id inserting a duplicate row on every retry.
 */
export function deriveEventId(provider: string, headers: WebhookHeaders, rawBody: Buffer): string {
  const deliveryId = extractDeliveryId(provider, headers, rawBody)
  return uuidv5(`${provider}:${deliveryId}`, NAMESPACE)
}

// null/undefined AND empty-string headers both fall through to the hash
// fallback below — a header that's merely present-but-empty must not derive
// a fixed, predictable id shared by every such request (see idempotency.test.ts).
function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}

function extractDeliveryId(provider: string, headers: WebhookHeaders, rawBody: Buffer): string {
  switch (provider) {
    case 'github':
      return nonEmpty(firstHeaderValue(headers['x-github-delivery'])) ?? hashRawBody(provider, rawBody)
    case 'shopify':
      return nonEmpty(firstHeaderValue(headers['x-shopify-webhook-id'])) ?? hashRawBody(provider, rawBody)
    case 'stripe':
      return extractStripeEventId(rawBody) ?? hashRawBody(provider, rawBody)
    default:
      return hashRawBody(provider, rawBody)
  }
}

// Stripe does not send a delivery-id header; the event body's own top-level
// `id` field (e.g. "evt_1AbCdE...") is Stripe's own dedup identifier.
function extractStripeEventId(rawBody: Buffer): string | undefined {
  const parsed = safeJsonParse(rawBody)
  if (parsed !== null && typeof parsed === 'object' && 'id' in parsed) {
    const id = (parsed as { id: unknown }).id
    return typeof id === 'string' ? nonEmpty(id) : undefined
  }
  return undefined
}

// Fallback for an unknown provider or a missing/empty/unparseable delivery
// id: still deterministic for identical redeliveries (same bytes hash the
// same way), just without the provider's own dedup guarantee — two
// genuinely distinct deliveries with byte-identical bodies would collide,
// an accepted tradeoff for providers we don't have a dedup header for.
function hashRawBody(provider: string, rawBody: Buffer): string {
  return createHash('sha256').update(`${provider}:${rawBody.toString('utf8')}`).digest('hex')
}

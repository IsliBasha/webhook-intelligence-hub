import { describe, expect, it } from 'vitest'
import { deriveEventId } from './idempotency.js'
import { makeHeaders } from '../providers/test-headers.js'

describe('deriveEventId', () => {
  it('returns the same id every time for identical (provider, headers, rawBody) input', () => {
    const headers = makeHeaders('x-github-delivery', '72d3162e-cc78-11e3-81ab-4c9367dc0958')
    const rawBody = Buffer.from(JSON.stringify({ action: 'opened' }))

    const first = deriveEventId('github', headers, rawBody)
    const second = deriveEventId('github', headers, rawBody)

    expect(first).toBe(second)
  })

  it('returns different ids for different GitHub delivery ids', () => {
    const rawBody = Buffer.from(JSON.stringify({ action: 'opened' }))

    const idA = deriveEventId('github', makeHeaders('x-github-delivery', 'delivery-a'), rawBody)
    const idB = deriveEventId('github', makeHeaders('x-github-delivery', 'delivery-b'), rawBody)

    expect(idA).not.toBe(idB)
  })

  it('derives the id from the x-shopify-webhook-id header for Shopify', () => {
    const rawBody = Buffer.from(JSON.stringify({ id: 123456 }))

    const idA = deriveEventId('shopify', makeHeaders('x-shopify-webhook-id', 'shop-delivery-a'), rawBody)
    const idB = deriveEventId('shopify', makeHeaders('x-shopify-webhook-id', 'shop-delivery-b'), rawBody)

    expect(idA).not.toBe(idB)
  })

  it('derives the id from the Stripe event body top-level id field, ignoring headers', () => {
    const rawBodyA = Buffer.from(JSON.stringify({ id: 'evt_1AbCdE', type: 'charge.failed' }))
    const rawBodyB = Buffer.from(JSON.stringify({ id: 'evt_2XyZaB', type: 'charge.failed' }))

    const idA = deriveEventId('stripe', {}, rawBodyA)
    const idB = deriveEventId('stripe', {}, rawBodyB)
    const idARepeat = deriveEventId('stripe', {}, rawBodyA)

    expect(idA).not.toBe(idB)
    expect(idA).toBe(idARepeat)
  })

  it('falls back to hashing the raw body for an unknown provider', () => {
    const rawBodyA = Buffer.from('payload-one')
    const rawBodyB = Buffer.from('payload-two')

    const idA = deriveEventId('unknown-provider', {}, rawBodyA)
    const idB = deriveEventId('unknown-provider', {}, rawBodyB)
    const idARepeat = deriveEventId('unknown-provider', {}, rawBodyA)

    expect(idA).not.toBe(idB)
    expect(idA).toBe(idARepeat)
  })

  it('falls back to hashing the raw body when the GitHub delivery header is missing', () => {
    const rawBodyA = Buffer.from(JSON.stringify({ action: 'opened' }))
    const rawBodyB = Buffer.from(JSON.stringify({ action: 'closed' }))

    const idA = deriveEventId('github', {}, rawBodyA)
    const idB = deriveEventId('github', {}, rawBodyB)

    expect(idA).not.toBe(idB)
  })

  it('falls back to hashing the raw body when the Shopify webhook-id header is missing', () => {
    const rawBodyA = Buffer.from(JSON.stringify({ id: 111 }))
    const rawBodyB = Buffer.from(JSON.stringify({ id: 222 }))

    const idA = deriveEventId('shopify', {}, rawBodyA)
    const idB = deriveEventId('shopify', {}, rawBodyB)

    expect(idA).not.toBe(idB)
  })

  it('treats an empty-but-present GitHub delivery header the same as a missing one, not as a fixed id', () => {
    // Regression test: `??` alone doesn't fall back on '', only null/undefined.
    // Two distinct bodies with an empty header must NOT collapse onto the
    // same derived id, or ON CONFLICT DO NOTHING would silently drop the
    // second event as a "duplicate" of the first.
    const rawBodyA = Buffer.from(JSON.stringify({ action: 'opened' }))
    const rawBodyB = Buffer.from(JSON.stringify({ action: 'closed' }))

    const idA = deriveEventId('github', makeHeaders('x-github-delivery', ''), rawBodyA)
    const idB = deriveEventId('github', makeHeaders('x-github-delivery', ''), rawBodyB)

    expect(idA).not.toBe(idB)
  })

  it('treats an empty-but-present Shopify webhook-id header the same as a missing one', () => {
    const rawBodyA = Buffer.from(JSON.stringify({ id: 111 }))
    const rawBodyB = Buffer.from(JSON.stringify({ id: 222 }))

    const idA = deriveEventId('shopify', makeHeaders('x-shopify-webhook-id', ''), rawBodyA)
    const idB = deriveEventId('shopify', makeHeaders('x-shopify-webhook-id', ''), rawBodyB)

    expect(idA).not.toBe(idB)
  })

  it('falls back to hashing the raw body when the Stripe body has no id field', () => {
    const rawBody = Buffer.from(JSON.stringify({ type: 'charge.failed' }))

    const id = deriveEventId('stripe', {}, rawBody)
    const idRepeat = deriveEventId('stripe', {}, rawBody)

    expect(id).toBe(idRepeat)
  })

  it('falls back to hashing the raw body when the Stripe body is not valid JSON', () => {
    const rawBody = Buffer.from('not json at all')

    const id = deriveEventId('stripe', {}, rawBody)
    const idRepeat = deriveEventId('stripe', {}, rawBody)

    expect(id).toBe(idRepeat)
  })

  it('returns a well-formed UUID string', () => {
    const rawBody = Buffer.from(JSON.stringify({ id: 'evt_1AbCdE' }))

    const id = deriveEventId('stripe', {}, rawBody)

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })
})

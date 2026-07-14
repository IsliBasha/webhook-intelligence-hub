import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyStripeSignature } from './stripe.js'
import { makeHeaders } from './test-headers.js'

const TEST_SECRET = 'stripe-test-secret'
const HEADER_NAME = 'stripe-signature'

function signPayload(secret: string, timestamp: number, body: Buffer): string {
  const signedPayload = `${timestamp}.${body.toString('utf8')}`
  const hex = createHmac('sha256', secret).update(signedPayload).digest('hex')
  return `t=${timestamp},v1=${hex}`
}

describe('verifyStripeSignature', () => {
  it('passes for a valid signature computed with the real secret', () => {
    const body = Buffer.from(JSON.stringify({ type: 'charge.succeeded' }))
    const timestamp = Math.floor(Date.now() / 1000)
    const header = signPayload(TEST_SECRET, timestamp, body)

    const result = verifyStripeSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, header))

    expect(result).toBe(true)
  })

  it('fails when the body differs from what was signed', () => {
    const signedBody = Buffer.from(JSON.stringify({ type: 'charge.succeeded' }))
    const tamperedBody = Buffer.from(JSON.stringify({ type: 'charge.failed' }))
    const timestamp = Math.floor(Date.now() / 1000)
    const header = signPayload(TEST_SECRET, timestamp, signedBody)

    const result = verifyStripeSignature(TEST_SECRET, tamperedBody, makeHeaders(HEADER_NAME, header))

    expect(result).toBe(false)
  })

  it('fails when verified with the wrong secret', () => {
    const body = Buffer.from(JSON.stringify({ type: 'charge.succeeded' }))
    const timestamp = Math.floor(Date.now() / 1000)
    const header = signPayload(TEST_SECRET, timestamp, body)

    const result = verifyStripeSignature('wrong-secret', body, makeHeaders(HEADER_NAME, header))

    expect(result).toBe(false)
  })

  it('fails without throwing when the header is missing', () => {
    const body = Buffer.from(JSON.stringify({ type: 'charge.succeeded' }))

    const result = verifyStripeSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, undefined))

    expect(result).toBe(false)
  })

  it('fails when the timestamp is older than 5 minutes, even with a correct HMAC', () => {
    const body = Buffer.from(JSON.stringify({ type: 'charge.succeeded' }))
    const staleTimestamp = Math.floor(Date.now() / 1000) - 301
    const header = signPayload(TEST_SECRET, staleTimestamp, body)

    const result = verifyStripeSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, header))

    expect(result).toBe(false)
  })

  it('passes when the timestamp is comfortably within the 5 minute window', () => {
    const body = Buffer.from(JSON.stringify({ type: 'charge.succeeded' }))
    // Not exactly 300s: real wall-clock time elapses between building this
    // header and verifyStripeSignature's own Date.now() call, so an exact
    // boundary value is inherently racy. 290s leaves headroom either way.
    const withinWindowTimestamp = Math.floor(Date.now() / 1000) - 290
    const header = signPayload(TEST_SECRET, withinWindowTimestamp, body)

    const result = verifyStripeSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, header))

    expect(result).toBe(true)
  })

  it('fails without throwing when the header has no v1= value', () => {
    const body = Buffer.from(JSON.stringify({ type: 'charge.succeeded' }))
    const timestamp = Math.floor(Date.now() / 1000)

    const result = verifyStripeSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, `t=${timestamp}`))

    expect(result).toBe(false)
  })

  it('fails without throwing when the header has no t= value', () => {
    const body = Buffer.from(JSON.stringify({ type: 'charge.succeeded' }))
    const timestamp = Math.floor(Date.now() / 1000)
    const header = signPayload(TEST_SECRET, timestamp, body).replace(/^t=\d+,/, '')

    const result = verifyStripeSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, header))

    expect(result).toBe(false)
  })

  it('fails without throwing when the header is empty garbage', () => {
    const body = Buffer.from(JSON.stringify({ type: 'charge.succeeded' }))

    const result = verifyStripeSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, 'garbage'))

    expect(result).toBe(false)
  })

  it('passes when any one of multiple v1= values matches (key rotation)', () => {
    const body = Buffer.from(JSON.stringify({ type: 'charge.succeeded' }))
    const timestamp = Math.floor(Date.now() / 1000)
    const validHeader = signPayload(TEST_SECRET, timestamp, body)
    const headerWithRotatedKeys = `${validHeader},v1=deadbeef`

    const result = verifyStripeSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, headerWithRotatedKeys))

    expect(result).toBe(true)
  })

  it('fails without throwing when a v1= value is shorter than the computed digest', () => {
    const body = Buffer.from(JSON.stringify({ type: 'charge.succeeded' }))
    const timestamp = Math.floor(Date.now() / 1000)

    const result = verifyStripeSignature(
      TEST_SECRET,
      body,
      makeHeaders(HEADER_NAME, `t=${timestamp},v1=deadbeef`)
    )

    expect(result).toBe(false)
  })

  it('fails without throwing when the timestamp is not a valid number', () => {
    const body = Buffer.from(JSON.stringify({ type: 'charge.succeeded' }))

    const result = verifyStripeSignature(
      TEST_SECRET,
      body,
      makeHeaders(HEADER_NAME, 't=not-a-number,v1=deadbeef')
    )

    expect(result).toBe(false)
  })

  it('passes when Express delivers the header as a single-element array', () => {
    const body = Buffer.from(JSON.stringify({ type: 'charge.succeeded' }))
    const timestamp = Math.floor(Date.now() / 1000)
    const header = signPayload(TEST_SECRET, timestamp, body)

    const result = verifyStripeSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, [header]))

    expect(result).toBe(true)
  })
})

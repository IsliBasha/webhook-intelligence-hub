import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyShopifySignature } from './shopify.js'
import { makeHeaders } from './test-headers.js'

const TEST_SECRET = 'shopify-test-secret'
const HEADER_NAME = 'x-shopify-hmac-sha256'

function signBody(secret: string, body: Buffer): string {
  return createHmac('sha256', secret).update(body).digest('base64')
}

describe('verifyShopifySignature', () => {
  it('passes for a valid signature computed with the real secret', () => {
    const body = Buffer.from(JSON.stringify({ id: 12345, total: '10.00' }))
    const signature = signBody(TEST_SECRET, body)

    const result = verifyShopifySignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, signature))

    expect(result).toBe(true)
  })

  it('fails when the body differs from what was signed', () => {
    const signedBody = Buffer.from(JSON.stringify({ id: 12345, total: '10.00' }))
    const tamperedBody = Buffer.from(JSON.stringify({ id: 12345, total: '99999.00' }))
    const signature = signBody(TEST_SECRET, signedBody)

    const result = verifyShopifySignature(TEST_SECRET, tamperedBody, makeHeaders(HEADER_NAME, signature))

    expect(result).toBe(false)
  })

  it('fails when verified with the wrong secret', () => {
    const body = Buffer.from(JSON.stringify({ id: 12345, total: '10.00' }))
    const signature = signBody(TEST_SECRET, body)

    const result = verifyShopifySignature('wrong-secret', body, makeHeaders(HEADER_NAME, signature))

    expect(result).toBe(false)
  })

  it('fails without throwing when the header is missing', () => {
    const body = Buffer.from(JSON.stringify({ id: 12345, total: '10.00' }))

    const result = verifyShopifySignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, undefined))

    expect(result).toBe(false)
  })

  it('fails without throwing when the header is malformed', () => {
    const body = Buffer.from(JSON.stringify({ id: 12345, total: '10.00' }))

    const result = verifyShopifySignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, 'not-valid-base64=='))

    expect(result).toBe(false)
  })

  it('passes when Express delivers the header as a single-element array', () => {
    const body = Buffer.from(JSON.stringify({ id: 12345, total: '10.00' }))
    const signature = signBody(TEST_SECRET, body)

    const result = verifyShopifySignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, [signature]))

    expect(result).toBe(true)
  })
})

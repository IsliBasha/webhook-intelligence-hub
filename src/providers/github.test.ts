import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyGitHubSignature } from './github.js'
import { makeHeaders } from './test-headers.js'

const TEST_SECRET = 'gh-test-secret'
const HEADER_NAME = 'x-hub-signature-256'

function signBody(secret: string, body: Buffer): string {
  const hex = createHmac('sha256', secret).update(body).digest('hex')
  return `sha256=${hex}`
}

describe('verifyGitHubSignature', () => {
  it('passes for a valid signature computed with the real secret', () => {
    const body = Buffer.from(JSON.stringify({ action: 'opened' }))
    const signature = signBody(TEST_SECRET, body)

    const result = verifyGitHubSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, signature))

    expect(result).toBe(true)
  })

  it('fails when the body differs from what was signed', () => {
    const signedBody = Buffer.from(JSON.stringify({ action: 'opened' }))
    const tamperedBody = Buffer.from(JSON.stringify({ action: 'closed' }))
    const signature = signBody(TEST_SECRET, signedBody)

    const result = verifyGitHubSignature(TEST_SECRET, tamperedBody, makeHeaders(HEADER_NAME, signature))

    expect(result).toBe(false)
  })

  it('fails when verified with the wrong secret', () => {
    const body = Buffer.from(JSON.stringify({ action: 'opened' }))
    const signature = signBody(TEST_SECRET, body)

    const result = verifyGitHubSignature('wrong-secret', body, makeHeaders(HEADER_NAME, signature))

    expect(result).toBe(false)
  })

  it('fails without throwing when the header is missing', () => {
    const body = Buffer.from(JSON.stringify({ action: 'opened' }))

    const result = verifyGitHubSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, undefined))

    expect(result).toBe(false)
  })

  it('fails without throwing when the header is malformed (no sha256= prefix)', () => {
    const body = Buffer.from(JSON.stringify({ action: 'opened' }))

    const result = verifyGitHubSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, 'not-a-real-signature'))

    expect(result).toBe(false)
  })

  it('fails without throwing when the provided hex is a different length than the computed digest', () => {
    const body = Buffer.from(JSON.stringify({ action: 'opened' }))

    const result = verifyGitHubSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, 'sha256=deadbeef'))

    expect(result).toBe(false)
  })

  it('passes when Express delivers the header as a single-element array', () => {
    const body = Buffer.from(JSON.stringify({ action: 'opened' }))
    const signature = signBody(TEST_SECRET, body)

    const result = verifyGitHubSignature(TEST_SECRET, body, makeHeaders(HEADER_NAME, [signature]))

    expect(result).toBe(true)
  })
})

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { firstHeaderValue } from './header-utils.js'

const MAX_TIMESTAMP_AGE_SECONDS = 300

/**
 * Stripe: Stripe-Signature header, format: t=<timestamp>,v1=<hmac>
 * Reject if timestamp older than 5 minutes (replay protection).
 */
export function verifyStripeSignature(secret: string, rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
  const signatureHeader = firstHeaderValue(headers['stripe-signature'])
  if (!signatureHeader) {
    return false
  }

  const { timestamp, signatures } = parseStripeSignatureHeader(signatureHeader)
  if (!timestamp || signatures.length === 0) {
    return false
  }

  if (!isTimestampFresh(timestamp)) {
    return false
  }

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`
  const computedHex = createHmac('sha256', secret).update(signedPayload).digest('hex')
  const computed = Buffer.from(computedHex, 'hex')

  return signatures.some((providedHex) => {
    const provided = Buffer.from(providedHex, 'hex')
    if (provided.length !== computed.length) {
      return false
    }
    return timingSafeEqual(provided, computed)
  })
}

interface StripeSignatureHeader {
  timestamp: string | undefined
  signatures: string[]
}

/**
 * Stripe headers can carry multiple v1= entries (key rotation). Collect all
 * of them; verification accepts if any one matches, matching Stripe SDK behavior.
 */
function parseStripeSignatureHeader(header: string): StripeSignatureHeader {
  let timestamp: string | undefined
  const signatures: string[] = []

  for (const part of header.split(',')) {
    const [key, value] = part.split('=', 2)
    if (key === 't' && value) {
      timestamp = value
    } else if (key === 'v1' && value) {
      signatures.push(value)
    }
  }

  return { timestamp, signatures }
}

function isTimestampFresh(timestamp: string): boolean {
  const timestampSeconds = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(timestampSeconds)) {
    return false
  }

  const nowSeconds = Date.now() / 1000
  return nowSeconds - timestampSeconds <= MAX_TIMESTAMP_AGE_SECONDS
}

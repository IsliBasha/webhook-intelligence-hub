import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { firstHeaderValue } from './header-utils.js'

const SIGNATURE_PREFIX = 'sha256='

/**
 * GitHub: X-Hub-Signature-256 header, format: sha256=<hex>
 * Requires raw body buffer — JSON.parse destroys the bytes needed for HMAC.
 */
export function verifyGitHubSignature(secret: string, rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
  const signatureHeader = firstHeaderValue(headers['x-hub-signature-256'])
  if (!signatureHeader || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false
  }

  const providedHex = signatureHeader.slice(SIGNATURE_PREFIX.length)
  const computedHex = createHmac('sha256', secret).update(rawBody).digest('hex')

  const provided = Buffer.from(providedHex, 'hex')
  const computed = Buffer.from(computedHex, 'hex')
  if (provided.length !== computed.length) {
    return false
  }

  return timingSafeEqual(provided, computed)
}

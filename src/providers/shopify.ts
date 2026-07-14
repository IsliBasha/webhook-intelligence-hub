import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import { firstHeaderValue } from './header-utils.js'

/**
 * Shopify: X-Shopify-Hmac-SHA256 header, format: base64(HMAC-SHA256)
 */
export function verifyShopifySignature(secret: string, rawBody: Buffer, headers: IncomingHttpHeaders): boolean {
  const signatureHeader = firstHeaderValue(headers['x-shopify-hmac-sha256'])
  if (!signatureHeader) {
    return false
  }

  const computedBase64 = createHmac('sha256', secret).update(rawBody).digest('base64')

  const provided = Buffer.from(signatureHeader, 'base64')
  const computed = Buffer.from(computedBase64, 'base64')
  if (provided.length !== computed.length) {
    return false
  }

  return timingSafeEqual(provided, computed)
}

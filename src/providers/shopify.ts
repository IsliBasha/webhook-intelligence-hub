import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'

/**
 * Shopify: X-Shopify-Hmac-SHA256 header, format: base64(HMAC-SHA256)
 */
export function verifyShopifySignature(secret: string, rawBody: Buffer, req: Request): boolean {
  // TODO P3.1: Base64 decode header, compute HMAC, timingSafeEqual
  void secret; void rawBody; void req; void createHmac; void timingSafeEqual
  throw new Error('Not implemented')
}

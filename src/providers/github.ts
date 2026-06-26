import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'

/**
 * GitHub: X-Hub-Signature-256 header, format: sha256=<hex>
 * Requires raw body buffer — JSON.parse destroys the bytes needed for HMAC.
 */
export function verifyGitHubSignature(secret: string, rawBody: Buffer, req: Request): boolean {
  // TODO P3.1
  void secret; void rawBody; void req; void createHmac; void timingSafeEqual
  throw new Error('Not implemented')
}

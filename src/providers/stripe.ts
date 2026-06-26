import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request } from 'express'

/**
 * Stripe: Stripe-Signature header, format: t=<timestamp>,v1=<hmac>
 * Reject if timestamp older than 5 minutes (replay protection).
 */
export function verifyStripeSignature(secret: string, rawBody: Buffer, req: Request): boolean {
  // TODO P3.1: Parse t= and v1= from header, check timestamp freshness
  void secret; void rawBody; void req; void createHmac; void timingSafeEqual
  throw new Error('Not implemented')
}

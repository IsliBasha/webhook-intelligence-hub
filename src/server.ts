import 'dotenv/config'
import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import { createServer } from 'node:http'
import { verifyGitHubSignature } from './providers/github.js'
import { verifyStripeSignature } from './providers/stripe.js'
import { verifyShopifySignature } from './providers/shopify.js'
import { handleVerifiedWebhook } from './routing/pipeline.js'

type SignatureVerifier = (secret: string, rawBody: Buffer, headers: Request['headers']) => boolean

interface ProviderConfig {
  verify: SignatureVerifier
  secretEnvVar: string
}

const PROVIDER_CONFIG: Record<string, ProviderConfig> = {
  github: { verify: verifyGitHubSignature, secretEnvVar: 'GITHUB_WEBHOOK_SECRET' },
  stripe: { verify: verifyStripeSignature, secretEnvVar: 'STRIPE_WEBHOOK_SECRET' },
  shopify: { verify: verifyShopifySignature, secretEnvVar: 'SHOPIFY_WEBHOOK_SECRET' },
}

// PROVIDER_CONFIG is a plain object literal, so a request to e.g.
// /webhooks/__proto__ or /webhooks/constructor would otherwise resolve to an
// inherited Object.prototype member instead of undefined. Every such lookup
// still ends up failing closed today (no secretEnvVar -> no secret -> 401),
// but only by accident; hasOwnProperty makes "unknown provider" a real 400
// instead of a coincidental 401.
function lookupProviderConfig(provider: string): ProviderConfig | undefined {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CONFIG, provider)
    ? PROVIDER_CONFIG[provider]
    : undefined
}

// Typical webhook payloads are a few KB; 5mb is a deliberate, generous
// ceiling (not body-parser's accidental 100kb default) sized to comfortably
// cover larger GitHub events (e.g. push with many commits) without leaving
// the endpoint effectively unbounded.
const WEBHOOK_BODY_LIMIT = '5mb'

const app = express()
const server = createServer(app)
app.disable('x-powered-by')

// Registered ahead of the global express.json() below, and scoped to this
// route only, so the raw byte stream survives for HMAC verification. If the
// global JSON parser ran first it would parse-and-discard the exact bytes
// the signature was computed over. This route is a terminal handler, so
// requests matching it never reach express.json() further down the stack;
// requests to every other route (e.g. /health) fall through to it as normal.
//
// type: () => true (instead of 'application/json') captures every
// content-type as raw bytes: some providers (e.g. GitHub ping/redelivery)
// send non-JSON content-types, and the HMAC check is the real gate here,
// not a content-type sniff.
app.post(
  '/webhooks/:provider',
  express.raw({ type: () => true, limit: WEBHOOK_BODY_LIMIT }),
  async (req, res, next) => {
    try {
      const provider = req.params.provider
      const config = lookupProviderConfig(provider)
      if (!config) {
        res.status(400).end()
        return
      }

      const secret = process.env[config.secretEnvVar]
      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      const isVerified = secret !== undefined && config.verify(secret, rawBody, req.headers)

      if (!isVerified) {
        // No body on failure — don't leak *why* verification failed.
        res.status(401).end()
        return
      }

      // Awaited before the ack is sent: the pipeline persists the event
      // synchronously, so the client only gets 200 after it's safely
      // stored — a fire-and-forget call here would risk losing events that
      // are acknowledged but never actually saved.
      await handleVerifiedWebhook(provider, rawBody, req.headers)
      res.status(200).end()
    } catch (err) {
      // Express 4 does not forward a rejected promise from an async handler
      // to error middleware automatically — without this, a throw here
      // (e.g. once handleVerifiedWebhook does real I/O) would hang the
      // request instead of returning a clean error response.
      next(err)
    }
  }
)

app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Catches body-parser errors (e.g. 413 payload-too-large from the raw-body
// limit above) and anything forwarded via next(err) above. Never echoes
// err.stack/err.message: Express's own default handler only suppresses that
// in NODE_ENV=production, and this app has no guarantee that's set in every
// deployment target.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err)
    return
  }
  const status = hasHttpStatus(err) ? err.status : 500
  res.status(status).end()
})

function hasHttpStatus(err: unknown): err is { status: number } {
  return typeof err === 'object' && err !== null && typeof (err as { status?: unknown }).status === 'number'
}

// No server.listen() here deliberately — importing this module (e.g. from
// tests via supertest, which binds its own ephemeral port) must not have the
// side effect of claiming a real OS port. See src/index.ts for the entrypoint
// that actually starts listening.
export { app, server }

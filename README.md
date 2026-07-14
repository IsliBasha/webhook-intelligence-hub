# webhook-intelligence-hub

Node.js webhook routing service. Receives events from GitHub / Stripe / Shopify, verifies HMAC signatures, classifies with Claude Haiku, persists to PostgreSQL with idempotency and a dead-letter queue, and routes critical/high-urgency events to Slack and Notion. The SSE dashboard is planned (see Roadmap).

> **Screenshot**: *(add dashboard screenshot before pushing)*

[![CI](https://github.com/IsliBasha/webhook-intelligence-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/IsliBasha/webhook-intelligence-hub/actions)

## Architecture

```
GitHub  --+
Stripe  --+--> HMAC Verify --> Claude Classify --> PostgreSQL (event store, idempotency, DLQ)
Shopify --+                                         +--> Slack + Notion (critical/high urgency only)
```

Slack/Notion routing uses real HTTP clients behind a mockable interface — real credentials aren't wired into a live deployment yet (see Roadmap). Planned: SSE dashboard.

## Providers and Signature Schemes

| Provider | Header | Format |
|----------|--------|--------|
| GitHub   | `X-Hub-Signature-256`       | `sha256=<hex>` |
| Stripe   | `Stripe-Signature`           | `t=<ts>,v1=<hex>` + replay guard |
| Shopify  | `X-Shopify-Hmac-SHA256`      | `base64(HMAC-SHA256)` |

## Quick Start

```bash
npm install
docker-compose up -d postgres
for f in migrations/*.sql; do psql $DATABASE_URL -f "$f"; done
cp .env.example .env
npm run dev
```

## Features
- Per-provider HMAC verification with timing-safe comparison
- PII/secret redaction before Claude classification calls — emails, IPs, phone numbers, known token formats, and any field with a sensitive-sounding key name (see Security below for known gaps)
- Idempotency — duplicate event IDs stored exactly once, keyed off each provider's own delivery ID; a redelivered webhook is a no-op instead of re-classifying and re-routing
- Dead letter queue in Postgres, with a `retry()` method that resets an event to `pending` for reprocessing
- Automatic retry-backoff scheduler — failed classifications retry with exponential backoff (1s/2s/4s/8s/16s), polling every 5s, moving to the DLQ once retries are exhausted
- Critical/high-urgency events routed to Slack (colored attachment) and Notion (database row); both channels are independent — one failing or being unconfigured never blocks the other or the webhook ack

## Roadmap
- Real credentials for Slack/Notion in a live deployment (currently mocked-client-only in tests)
- Real-time dashboard (SSE)
- Deploy packaging (Docker Compose, deploy-host agnostic)

## Security

- **HMAC verification** on every provider (see table above), constant-time comparison, no verification-failure detail leaked in the response.
- **PII/secret redaction before the Claude API call** (emails, IPs, phone numbers, known token formats, sensitive-keyed fields) — this is a regex/key-based best-effort layer, not a full PII-detection model. It does not catch names, physical addresses, or unlabeled free-text secrets with no recognizable format.
- **Raw webhook payloads are stored unscrubbed in Postgres** (`webhook_events.raw_payload`), by design — redaction only applies to what's sent to the external Claude API, not to what's persisted, to preserve full audit fidelity for on-call review. This means Postgres itself is a sensitive data store: it should never be publicly reachable, and access should be restricted to the app and trusted operators.
- **No secrets committed** — all credentials via `.env`, `.env.example` documents the required variables with placeholder values only.
- **Outbound Slack/Notion errors never surface the destination URL or token** — `fetch()` failures (e.g. a malformed webhook URL) are caught and replaced with a generic message before being persisted to `webhook_events.last_error`, since Node's `fetch` otherwise embeds the raw request URL in its own error text.

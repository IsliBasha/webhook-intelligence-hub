# webhook-intelligence-hub

Node.js webhook routing service. Receives events from GitHub / Stripe / Shopify, verifies HMAC signatures, classifies with Claude Haiku, and routes to Slack / Notion / PostgreSQL. Real-time SSE dashboard.

> **Screenshot**: *(add dashboard screenshot before pushing)*

[![CI](https://github.com/IsliBasha/webhook-intelligence-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/IsliBasha/webhook-intelligence-hub/actions)

## Architecture

```
GitHub  --+
Stripe  --+--> HMAC Verify --> Claude Classify --> Route --> Slack / Notion
Shopify --+                                         +--> PostgreSQL (all)
                                                    +--> SSE Dashboard
```

## Providers and Signature Schemes

| Provider | Header | Format |
|----------|--------|--------|
| GitHub   | `X-Hub-Signature-256`       | `sha256=<hex>` |
| Stripe   | `Stripe-Signature`           | `t=<ts>,v1=<hex>` + replay guard |
| Shopify  | `X-Shopify-Hmac-SHA256`      | `base64(HMAC-SHA256)` |

## Quick Start

```bash
npm install
docker-compose up -d postgres redis
psql $DATABASE_URL -f migrations/001_initial.sql
cp .env.example .env
npm run dev
```

## Features
- Per-provider HMAC verification with timing-safe comparison
- PII stripping before Claude classification calls
- Idempotency — duplicate event IDs stored exactly once
- Dead letter queue with manual retry UI
- Exponential backoff retry via Redis sorted sets
- Server-Sent Events real-time dashboard

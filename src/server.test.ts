import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import request from 'supertest'

const TEST_SECRET = 'test-secret'
process.env.GITHUB_WEBHOOK_SECRET = TEST_SECRET

// This suite tests the HTTP/HMAC layer only (signature verification, status
// codes, body-size limits) — not the downstream classify/store/route
// pipeline, which src/routing/pipeline.test.ts already covers with its own
// mocks. Without this mock, importing server.js would transitively import
// the real pipeline -> real Postgres pool -> throw at import time if
// DATABASE_URL isn't set (or worse, silently connect to whatever's on the
// default Postgres port if it were relaxed to not throw).
const { handleVerifiedWebhookMock } = vi.hoisted(() => ({
  handleVerifiedWebhookMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./routing/pipeline.js', () => ({
  handleVerifiedWebhook: handleVerifiedWebhookMock,
}))

const { app } = await import('./server.js')

// supertest/superagent JSON-serializes non-string bodies when the
// Content-Type is application/json, which would mangle a raw Buffer before
// it hits the wire. Sign and send the exact UTF-8 string instead — that's
// byte-identical to Buffer.from(bodyString) on the receiving end, where
// express.raw() reconstructs it back into a Buffer.
function signGitHubBody(bodyString: string): string {
  const hex = createHmac('sha256', TEST_SECRET).update(bodyString).digest('hex')
  return `sha256=${hex}`
}

describe('POST /webhooks/:provider', () => {
  it('returns 200 for a validly-signed GitHub payload', async () => {
    const bodyString = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'octocat/hello-world' },
    })
    const signature = signGitHubBody(bodyString)

    const response = await request(app)
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(bodyString)

    expect(response.status).toBe(200)
  })

  it('returns 401 for a tampered GitHub payload', async () => {
    const signedBodyString = JSON.stringify({
      action: 'opened',
      repository: { full_name: 'octocat/hello-world' },
    })
    const signature = signGitHubBody(signedBodyString)

    const tamperedBodyString = JSON.stringify({
      action: 'closed',
      repository: { full_name: 'octocat/hello-world' },
    })

    const response = await request(app)
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(tamperedBodyString)

    expect(response.status).toBe(401)
    expect(response.body).toEqual({})
    expect(response.text).toBe('')
  })

  it('returns 401 when the signature header is missing', async () => {
    const bodyString = JSON.stringify({ action: 'opened' })

    const response = await request(app)
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .send(bodyString)

    expect(response.status).toBe(401)
  })

  it('returns 400 for an unknown provider', async () => {
    const response = await request(app)
      .post('/webhooks/unknown-provider')
      .set('Content-Type', 'application/json')
      .send('{}')

    expect(response.status).toBe(400)
  })

  it('returns 400 (not an inherited-property 401) for a prototype-probing provider name', async () => {
    const response = await request(app)
      .post('/webhooks/__proto__')
      .set('Content-Type', 'application/json')
      .send('{}')

    expect(response.status).toBe(400)
  })

  it('returns 413 with no leaked stack trace when the body exceeds the size limit', async () => {
    const oversizedBody = 'a'.repeat(6 * 1024 * 1024) // over the 5mb limit

    const response = await request(app)
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .send(oversizedBody)

    expect(response.status).toBe(413)
    expect(response.text).toBe('')
    expect(response.text).not.toMatch(/at\s+\S+\s+\(.*:\d+:\d+\)/) // no stack-trace-shaped output
  })

  it('returns 500 with no leaked details when the pipeline rejects — exercises the try/catch -> next(err) path', async () => {
    handleVerifiedWebhookMock.mockRejectedValueOnce(new Error('db exploded'))

    const bodyString = JSON.stringify({ action: 'opened' })
    const signature = signGitHubBody(bodyString)

    const response = await request(app)
      .post('/webhooks/github')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(bodyString)

    expect(response.status).toBe(500)
    expect(response.text).toBe('')
    expect(response.text).not.toContain('db exploded')
  })
})

describe('GET /health', () => {
  it('still returns ok status via the normal JSON-parsing path', async () => {
    const response = await request(app).get('/health')

    expect(response.status).toBe(200)
    expect(response.body.status).toBe('ok')
  })
})

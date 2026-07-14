import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ClassificationError } from '../processing/classifier.js'
import type { WebhookEvent } from '../storage/event-store.js'

type SaveInput = Omit<WebhookEvent, 'created_at' | 'attempts'>

// classifyEvent is already tested in src/processing/classifier.test.ts —
// this file only needs to verify the pipeline's own orchestration (save ->
// classify -> markProcessed, or markFailed on a ClassificationError without
// propagating it). ClassificationError itself is kept real (not mocked) so
// `err instanceof ClassificationError` in pipeline.ts still works against
// instances constructed here.
const { classifyEventMock } = vi.hoisted(() => ({ classifyEventMock: vi.fn() }))

vi.mock('../processing/classifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../processing/classifier.js')>()
  return { ...actual, classifyEvent: classifyEventMock }
})

// EventStore is mocked (not run against real Postgres) so this suite tests
// the pipeline's call contract in isolation and fast, without needing a DB
// connection — the *actual* persistence behavior (idempotency, status
// transitions) is covered by src/storage/event-store.test.ts's real
// integration tests instead of being re-asserted here.
const { saveMock, markProcessedMock, markFailedMock, recordRoutingErrorMock } = vi.hoisted(() => ({
  saveMock: vi.fn<(event: SaveInput) => Promise<{ isNew: boolean; status: string }>>(),
  markProcessedMock: vi.fn<(id: string, classified: unknown) => Promise<void>>(),
  markFailedMock: vi.fn<(id: string, error: string) => Promise<{ attempts: number }>>(),
  recordRoutingErrorMock: vi.fn<(id: string, error: string) => Promise<void>>(),
}))

vi.mock('../storage/event-store.js', () => ({
  EventStore: vi.fn().mockImplementation(() => ({
    save: saveMock,
    markProcessed: markProcessedMock,
    markFailed: markFailedMock,
    recordRoutingError: recordRoutingErrorMock,
  })),
  MAX_RETRY_ATTEMPTS: 5,
}))

// pool.ts throws at import time if DATABASE_URL is unset; pipeline.ts
// imports it purely to construct the (now-mocked) EventStore above, so the
// real pg.Pool must never be constructed in this test file.
vi.mock('../storage/pool.js', () => ({ pool: {} }))

// routeEvent is mocked so this suite verifies pipeline.ts calls it with the
// right arguments after a successful classification, without exercising the
// real Slack/Notion HTTP clients (those are covered by their own test
// files and by router.test.ts's orchestration tests).
const { routeEventMock } = vi.hoisted(() => ({ routeEventMock: vi.fn() }))

vi.mock('./router.js', () => ({ routeEvent: routeEventMock }))

// DeadLetterQueue is mocked so this suite can verify pipeline.ts moves an
// event to the DLQ once retries are exhausted, without needing a real
// Postgres connection (dead-letter.ts's own real-DB behavior is covered by
// dead-letter.test.ts).
const { dlqMoveMock } = vi.hoisted(() => ({ dlqMoveMock: vi.fn() }))

vi.mock('./dead-letter.js', () => ({
  DeadLetterQueue: vi.fn().mockImplementation(() => ({ move: dlqMoveMock })),
}))

const { handleVerifiedWebhook } = await import('./pipeline.js')

const GITHUB_HEADERS = {
  'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
  'x-github-event': 'push',
}

function githubBody(): Buffer {
  return Buffer.from(
    JSON.stringify({ ref: 'refs/heads/main', repository: { full_name: 'octocat/hello-world' } })
  )
}

const VALID_CLASSIFICATION = {
  urgency: 'normal',
  category: 'deployment',
  summary: 'A push was made to main.',
  suggested_actions: ['No action needed'],
}

describe('handleVerifiedWebhook', () => {
  beforeEach(() => {
    saveMock.mockReset().mockResolvedValue({ isNew: true, status: 'pending' })
    markProcessedMock.mockReset().mockResolvedValue(undefined)
    markFailedMock.mockReset().mockResolvedValue({ attempts: 1 })
    recordRoutingErrorMock.mockReset().mockResolvedValue(undefined)
    classifyEventMock.mockReset()
    routeEventMock.mockReset().mockResolvedValue(undefined)
    dlqMoveMock.mockReset().mockResolvedValue(undefined)
  })

  it('saves the raw event once, classifies it, and marks it processed with the classification on success', async () => {
    classifyEventMock.mockResolvedValue(VALID_CLASSIFICATION)

    await handleVerifiedWebhook('github', githubBody(), GITHUB_HEADERS)

    expect(saveMock).toHaveBeenCalledTimes(1)
    const savedEvent = saveMock.mock.calls[0][0]
    expect(savedEvent.provider).toBe('github')
    expect(savedEvent.event_type).toBe('push')
    expect(savedEvent.status).toBe('pending')
    expect(typeof savedEvent.id).toBe('string')

    expect(classifyEventMock).toHaveBeenCalledTimes(1)
    expect(classifyEventMock).toHaveBeenCalledWith(
      'github',
      'push',
      expect.objectContaining({ ref: 'refs/heads/main' })
    )

    expect(markProcessedMock).toHaveBeenCalledWith(savedEvent.id, VALID_CLASSIFICATION)
    expect(markFailedMock).not.toHaveBeenCalled()
  })

  it('routes the event after a successful classification, with the same id/provider/event_type/classification', async () => {
    classifyEventMock.mockResolvedValue(VALID_CLASSIFICATION)

    await handleVerifiedWebhook('github', githubBody(), GITHUB_HEADERS)

    const savedEvent = saveMock.mock.calls[0][0]
    expect(routeEventMock).toHaveBeenCalledTimes(1)
    expect(routeEventMock).toHaveBeenCalledWith(
      savedEvent.id,
      'github',
      'push',
      VALID_CLASSIFICATION,
      expect.anything()
    )
    // routeEvent must run after markProcessed: routing critical/high events
    // to Slack/Notion before the row is durably marked processed would mean
    // a crash between the two calls could notify without ever persisting.
    expect(markProcessedMock.mock.invocationCallOrder[0]).toBeLessThan(
      routeEventMock.mock.invocationCallOrder[0]
    )
  })

  it('does not route the event when classification fails', async () => {
    classifyEventMock.mockRejectedValue(
      new ClassificationError('boom', 'github', 'push', new Error('cause'))
    )

    await handleVerifiedWebhook('github', githubBody(), GITHUB_HEADERS)

    expect(routeEventMock).not.toHaveBeenCalled()
  })

  it('saves the raw event before attempting classification, so a classification failure never loses it', async () => {
    classifyEventMock.mockRejectedValue(
      new ClassificationError('boom', 'github', 'push', new Error('cause'))
    )

    await handleVerifiedWebhook('github', githubBody(), GITHUB_HEADERS)

    expect(saveMock).toHaveBeenCalledTimes(1)
    // Proves ordering, not just presence: save's invocation index must be
    // lower than classifyEvent's, or this only shows both were called, not
    // that persistence happened first.
    expect(saveMock.mock.invocationCallOrder[0]).toBeLessThan(
      classifyEventMock.mock.invocationCallOrder[0]
    )
  })

  it('marks the event failed (not processed) on a ClassificationError, and resolves instead of throwing', async () => {
    classifyEventMock.mockRejectedValue(
      new ClassificationError('Failed to classify push event from github', 'github', 'push', new Error('cause'))
    )

    await expect(handleVerifiedWebhook('github', githubBody(), GITHUB_HEADERS)).resolves.toBeUndefined()

    expect(markFailedMock).toHaveBeenCalledTimes(1)
    const [failedId, errorMessage] = markFailedMock.mock.calls[0]
    expect(typeof failedId).toBe('string')
    expect(errorMessage).toBe('Failed to classify push event from github')
    expect(markProcessedMock).not.toHaveBeenCalled()
  })

  it('does not move the event to the DLQ when markFailed reports attempts still under MAX_RETRY_ATTEMPTS', async () => {
    markFailedMock.mockResolvedValue({ attempts: 3 })
    classifyEventMock.mockRejectedValue(
      new ClassificationError('boom', 'github', 'push', new Error('cause'))
    )

    await handleVerifiedWebhook('github', githubBody(), GITHUB_HEADERS)

    expect(dlqMoveMock).not.toHaveBeenCalled()
  })

  it('moves the event to the DLQ once markFailed reports attempts have reached MAX_RETRY_ATTEMPTS', async () => {
    markFailedMock.mockResolvedValue({ attempts: 5 })
    classifyEventMock.mockRejectedValue(
      new ClassificationError('Failed to classify push event from github', 'github', 'push', new Error('cause'))
    )

    await handleVerifiedWebhook('github', githubBody(), GITHUB_HEADERS)

    expect(dlqMoveMock).toHaveBeenCalledTimes(1)
    const [eventId, error] = dlqMoveMock.mock.calls[0]
    expect(typeof eventId).toBe('string')
    expect(error).toBe('Failed to classify push event from github')
  })

  it('skips classification and routing entirely on a redelivery of an already-PROCESSED event', async () => {
    saveMock.mockResolvedValue({ isNew: false, status: 'processed' })
    classifyEventMock.mockResolvedValue(VALID_CLASSIFICATION)

    await expect(handleVerifiedWebhook('github', githubBody(), GITHUB_HEADERS)).resolves.toBeUndefined()

    expect(classifyEventMock).not.toHaveBeenCalled()
    expect(markProcessedMock).not.toHaveBeenCalled()
    expect(markFailedMock).not.toHaveBeenCalled()
    expect(routeEventMock).not.toHaveBeenCalled()
  })

  it('still reprocesses on redelivery when the existing row is stuck at "pending" (crash-recovery case)', async () => {
    // A row can be stuck at 'pending' if the original attempt crashed
    // between save() and markProcessed/markFailed, or if
    // DeadLetterQueue.retry() just reset it. Skipping here (as an earlier,
    // buggier version of this guard did) would strand the event forever —
    // claimForRetry only looks at 'failed' rows, so a stuck 'pending' row
    // would have no other path back to being processed.
    saveMock.mockResolvedValue({ isNew: false, status: 'pending' })
    classifyEventMock.mockResolvedValue(VALID_CLASSIFICATION)

    await handleVerifiedWebhook('github', githubBody(), GITHUB_HEADERS)

    expect(classifyEventMock).toHaveBeenCalledTimes(1)
    expect(markProcessedMock).toHaveBeenCalledTimes(1)
  })

  it('still reprocesses on redelivery when the existing row is stuck at "failed"', async () => {
    saveMock.mockResolvedValue({ isNew: false, status: 'failed' })
    classifyEventMock.mockResolvedValue(VALID_CLASSIFICATION)

    await handleVerifiedWebhook('github', githubBody(), GITHUB_HEADERS)

    expect(classifyEventMock).toHaveBeenCalledTimes(1)
    expect(markProcessedMock).toHaveBeenCalledTimes(1)
  })

  it('re-throws unexpected (non-ClassificationError) errors instead of swallowing them', async () => {
    classifyEventMock.mockRejectedValue(new Error('network blew up'))

    await expect(handleVerifiedWebhook('github', githubBody(), GITHUB_HEADERS)).rejects.toThrow(
      'network blew up'
    )

    expect(markFailedMock).not.toHaveBeenCalled()
  })

  it('derives event_type from the Stripe body (not a header) for Stripe events', async () => {
    classifyEventMock.mockResolvedValue(VALID_CLASSIFICATION)
    const stripeBody = Buffer.from(JSON.stringify({ id: 'evt_1AbCdE', type: 'charge.failed' }))

    await handleVerifiedWebhook('stripe', stripeBody, {})

    const savedEvent = saveMock.mock.calls[0][0]
    expect(savedEvent.event_type).toBe('charge.failed')
    expect(classifyEventMock).toHaveBeenCalledWith(
      'stripe',
      'charge.failed',
      expect.objectContaining({ id: 'evt_1AbCdE' })
    )
  })

  it('uses "unknown" as the event type for an unrecognized provider', async () => {
    classifyEventMock.mockResolvedValue(VALID_CLASSIFICATION)

    await handleVerifiedWebhook('unknown-provider', Buffer.from('{}'), {})

    const savedEvent = saveMock.mock.calls[0][0]
    expect(savedEvent.event_type).toBe('unknown')
  })

  it('derives the same event id for the same GitHub delivery across two calls (idempotent id derivation)', async () => {
    classifyEventMock.mockResolvedValue(VALID_CLASSIFICATION)

    await handleVerifiedWebhook('github', githubBody(), GITHUB_HEADERS)
    await handleVerifiedWebhook('github', githubBody(), GITHUB_HEADERS)

    const firstId = saveMock.mock.calls[0][0].id
    const secondId = saveMock.mock.calls[1][0].id
    expect(firstId).toBe(secondId)
  })

  it('derives event_type from the x-shopify-topic header for Shopify events', async () => {
    classifyEventMock.mockResolvedValue(VALID_CLASSIFICATION)
    const shopifyBody = Buffer.from(JSON.stringify({ id: 123456, email: 'buyer@example.com' }))

    await handleVerifiedWebhook('shopify', shopifyBody, { 'x-shopify-topic': 'orders/create' })

    const savedEvent = saveMock.mock.calls[0][0]
    expect(savedEvent.event_type).toBe('orders/create')
  })

  it('rejects instead of hanging when the raw body is not valid JSON', async () => {
    await expect(
      handleVerifiedWebhook('stripe', Buffer.from('not json at all'), {})
    ).rejects.toThrow()

    // The malformed body never gets far enough to classify or persist —
    // this is an unexpected failure (unparseable payload), not a handled
    // ClassificationError, so nothing should have been saved or marked failed.
    expect(saveMock).not.toHaveBeenCalled()
    expect(markFailedMock).not.toHaveBeenCalled()
  })
})

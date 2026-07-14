import { describe, expect, it, vi } from 'vitest'
import type { ClassifiedEvent } from '../processing/classifier.js'
import { routeEvent } from './router.js'

function classified(overrides: Partial<ClassifiedEvent> = {}): ClassifiedEvent {
  return {
    urgency: 'critical',
    category: 'payment',
    summary: 'A payment failed.',
    suggested_actions: ['Check the payment gateway'],
    ...overrides,
  }
}

describe('routeEvent', () => {
  it('sends critical events to both Slack and Notion when both clients are configured', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)
    const createPage = vi.fn().mockResolvedValue(undefined)
    const recordRoutingError = vi.fn().mockResolvedValue(undefined)

    await routeEvent('evt-1', 'stripe', 'charge.failed', classified(), {
      slackClient: { postMessage },
      notion: { client: { createPage }, databaseId: 'db-1' },
      recordRoutingError,
    })

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(createPage).toHaveBeenCalledTimes(1)
    expect(recordRoutingError).not.toHaveBeenCalled()
  })

  it('does not attempt Slack or Notion for normal/low urgency events', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)
    const createPage = vi.fn().mockResolvedValue(undefined)

    await routeEvent('evt-2', 'shopify', 'orders/create', classified({ urgency: 'normal' }), {
      slackClient: { postMessage },
      notion: { client: { createPage }, databaseId: 'db-1' },
      recordRoutingError: vi.fn(),
    })

    expect(postMessage).not.toHaveBeenCalled()
    expect(createPage).not.toHaveBeenCalled()
  })

  it('skips Slack silently (no throw, no error record) when no Slack client is configured', async () => {
    const createPage = vi.fn().mockResolvedValue(undefined)
    const recordRoutingError = vi.fn().mockResolvedValue(undefined)

    await routeEvent('evt-3', 'github', 'push', classified({ urgency: 'high' }), {
      slackClient: undefined,
      notion: { client: { createPage }, databaseId: 'db-1' },
      recordRoutingError,
    })

    expect(createPage).toHaveBeenCalledTimes(1)
    expect(recordRoutingError).not.toHaveBeenCalled()
  })

  it('skips Notion silently when no Notion client is configured', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)
    const recordRoutingError = vi.fn().mockResolvedValue(undefined)

    await routeEvent('evt-4', 'github', 'push', classified({ urgency: 'high' }), {
      slackClient: { postMessage },
      notion: undefined,
      recordRoutingError,
    })

    expect(postMessage).toHaveBeenCalledTimes(1)
    expect(recordRoutingError).not.toHaveBeenCalled()
  })

  it('still delivers to Notion when Slack fails, and records the Slack failure instead of throwing', async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error('Slack webhook failed: 500'))
    const createPage = vi.fn().mockResolvedValue(undefined)
    const recordRoutingError = vi.fn().mockResolvedValue(undefined)

    await expect(
      routeEvent('evt-5', 'stripe', 'charge.failed', classified(), {
        slackClient: { postMessage },
        notion: { client: { createPage }, databaseId: 'db-1' },
        recordRoutingError,
      })
    ).resolves.toBeUndefined()

    expect(createPage).toHaveBeenCalledTimes(1)
    expect(recordRoutingError).toHaveBeenCalledTimes(1)
    const [eventId, message] = recordRoutingError.mock.calls[0]
    expect(eventId).toBe('evt-5')
    expect(message).toContain('Slack webhook failed: 500')
  })

  it('records both failures when Slack and Notion both fail, without crashing the caller', async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error('Slack down'))
    const createPage = vi.fn().mockRejectedValue(new Error('Notion down'))
    const recordRoutingError = vi.fn().mockResolvedValue(undefined)

    await routeEvent('evt-6', 'stripe', 'charge.failed', classified(), {
      slackClient: { postMessage },
      notion: { client: { createPage }, databaseId: 'db-1' },
      recordRoutingError,
    })

    expect(recordRoutingError).toHaveBeenCalledTimes(1)
    const [, message] = recordRoutingError.mock.calls[0]
    expect(message).toContain('Slack down')
    expect(message).toContain('Notion down')
  })

  it('still resolves (never rejects) when recordRoutingError itself throws', async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error('Slack down'))
    const recordRoutingError = vi.fn().mockRejectedValue(new Error('DB connection lost'))

    // A Postgres blip while recording a routing failure must never surface
    // as routeEvent rejecting — pipeline.ts relies on that contract to keep
    // a Slack/Notion outage from turning into a false webhook-delivery
    // failure (which would trigger a redelivery and duplicate the alert).
    await expect(
      routeEvent('evt-7', 'stripe', 'charge.failed', classified(), {
        slackClient: { postMessage },
        notion: undefined,
        recordRoutingError,
      })
    ).resolves.toBeUndefined()

    expect(recordRoutingError).toHaveBeenCalledTimes(1)
  })
})

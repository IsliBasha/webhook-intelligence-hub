import { describe, expect, it, vi } from 'vitest'
import type { ClassifiedEvent } from '../processing/classifier.js'
import { routeToSlack } from './slack-router.js'

function classified(overrides: Partial<ClassifiedEvent> = {}): ClassifiedEvent {
  return {
    urgency: 'critical',
    category: 'payment',
    summary: 'A payment failed.',
    suggested_actions: ['Check the payment gateway'],
    ...overrides,
  }
}

describe('routeToSlack', () => {
  it('posts a message with provider, urgency, summary, actions, and event id for a critical event', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)

    await routeToSlack({ postMessage }, 'evt-1', 'stripe', classified())

    expect(postMessage).toHaveBeenCalledTimes(1)
    const [payload] = postMessage.mock.calls[0]
    const [attachment] = (payload as { attachments: Array<Record<string, unknown>> }).attachments
    expect(attachment.color).toBe('#e01e5a')
    const fields = attachment.fields as Array<{ title: string; value: string }>
    expect(fields).toEqual(
      expect.arrayContaining([
        { title: 'Provider', value: 'stripe', short: true },
        { title: 'Urgency', value: 'critical', short: true },
        { title: 'Summary', value: 'A payment failed.' },
        { title: 'Suggested actions', value: 'Check the payment gateway' },
        { title: 'Event ID', value: 'evt-1' },
      ])
    )
  })

  it('uses a distinct color for high urgency vs critical', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)

    await routeToSlack({ postMessage }, 'evt-2', 'github', classified({ urgency: 'high' }))

    const [payload] = postMessage.mock.calls[0]
    const [attachment] = (payload as { attachments: Array<{ color: string }> }).attachments
    expect(attachment.color).toBe('#ecb22e')
    expect(attachment.color).not.toBe('#e01e5a')
  })

  it('does not post for normal or low urgency events', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)

    await routeToSlack({ postMessage }, 'evt-3', 'shopify', classified({ urgency: 'normal' }))
    await routeToSlack({ postMessage }, 'evt-4', 'shopify', classified({ urgency: 'low' }))

    expect(postMessage).not.toHaveBeenCalled()
  })

  it('joins multiple suggested actions with a separator instead of dropping them', async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined)

    await routeToSlack(
      { postMessage },
      'evt-5',
      'stripe',
      classified({ suggested_actions: ['Check gateway', 'Notify on-call'] })
    )

    const [payload] = postMessage.mock.calls[0]
    const [attachment] = (payload as { attachments: Array<Record<string, unknown>> }).attachments
    const fields = attachment.fields as Array<{ title: string; value: string }>
    const actionsField = fields.find((field) => field.title === 'Suggested actions')
    expect(actionsField?.value).toBe('Check gateway; Notify on-call')
  })

  it('propagates a client error instead of swallowing it', async () => {
    const postMessage = vi.fn().mockRejectedValue(new Error('Slack webhook failed: 500'))

    await expect(routeToSlack({ postMessage }, 'evt-6', 'stripe', classified())).rejects.toThrow(
      'Slack webhook failed: 500'
    )
  })
})

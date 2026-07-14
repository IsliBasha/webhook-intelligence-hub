import { describe, expect, it, vi } from 'vitest'
import type { ClassifiedEvent } from '../processing/classifier.js'
import { routeToNotion } from './notion-router.js'

function classified(overrides: Partial<ClassifiedEvent> = {}): ClassifiedEvent {
  return {
    urgency: 'high',
    category: 'deployment',
    summary: 'A deployment failed.',
    suggested_actions: ['Roll back the release'],
    ...overrides,
  }
}

describe('routeToNotion', () => {
  it('creates a page in the given database with provider, event type, summary, urgency, and event id', async () => {
    const createPage = vi.fn().mockResolvedValue(undefined)

    await routeToNotion({ createPage }, 'db-123', 'evt-1', 'github', 'deployment_status', classified())

    expect(createPage).toHaveBeenCalledTimes(1)
    const [payload] = createPage.mock.calls[0] as [Record<string, unknown>]
    expect(payload.parent).toEqual({ database_id: 'db-123' })
    const properties = payload.properties as Record<string, unknown>
    expect(properties.Provider).toEqual({ rich_text: [{ text: { content: 'github' } }] })
    expect(properties['Event Type']).toEqual({ rich_text: [{ text: { content: 'deployment_status' } }] })
    expect(properties.Summary).toEqual({ rich_text: [{ text: { content: 'A deployment failed.' } }] })
    expect(properties.Urgency).toEqual({ select: { name: 'high' } })
    expect(properties['Event ID']).toEqual({ rich_text: [{ text: { content: 'evt-1' } }] })
  })

  it('does not create a page for normal or low urgency events', async () => {
    const createPage = vi.fn().mockResolvedValue(undefined)

    await routeToNotion({ createPage }, 'db-123', 'evt-2', 'shopify', 'orders/create', classified({ urgency: 'normal' }))
    await routeToNotion({ createPage }, 'db-123', 'evt-3', 'shopify', 'orders/create', classified({ urgency: 'low' }))

    expect(createPage).not.toHaveBeenCalled()
  })

  it('propagates a client error instead of swallowing it', async () => {
    const createPage = vi.fn().mockRejectedValue(new Error('Notion API failed: 400'))

    await expect(
      routeToNotion({ createPage }, 'db-123', 'evt-4', 'github', 'deployment_status', classified())
    ).rejects.toThrow('Notion API failed: 400')
  })
})

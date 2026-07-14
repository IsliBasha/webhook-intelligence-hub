import type { ClassifiedEvent } from '../processing/classifier.js'
import { isAlertUrgency } from './urgency.js'

export interface NotionClient {
  createPage(payload: unknown): Promise<void>
}

const FETCH_TIMEOUT_MS = 5000

// Real HTTP client for the Notion API. Kept separate from NotionClient (the
// interface) so tests inject a mock instead of exercising a real network
// call — matches the "mocked clients only, real creds wired later" decision
// for P3.4.
export class HttpNotionClient implements NotionClient {
  private static readonly API_URL = 'https://api.notion.com/v1/pages'
  private static readonly NOTION_VERSION = '2022-06-28'

  constructor(private readonly token: string) {}

  async createPage(payload: unknown): Promise<void> {
    let response: Response
    try {
      response = await fetch(HttpNotionClient.API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'Notion-Version': HttpNotionClient.NOTION_VERSION,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch {
      // Never surface fetch()'s own error message — see the matching
      // HttpSlackClient comment. API_URL is a hardcoded constant here so
      // the Bearer token can't leak this way today, but the same defensive
      // pattern keeps this client safe if that ever changes.
      throw new Error('Notion API request failed')
    }
    if (!response.ok) {
      throw new Error(`Notion API failed: ${response.status}`)
    }
  }
}

// Notion rich_text properties have a documented 2000-character limit per
// text object; eventType is header-derived (X-GitHub-Event,
// X-Shopify-Topic, or the Stripe body's own type) and, unlike the webhook
// body, never passes through PII stripping — capping it keeps a malformed
// or oversized header from causing an avoidable 400 from Notion's API.
const MAX_EVENT_TYPE_LENGTH = 200

function richText(content: string): { rich_text: [{ text: { content: string } }] } {
  return { rich_text: [{ text: { content } }] }
}

export async function routeToNotion(
  client: NotionClient,
  databaseId: string,
  eventId: string,
  provider: string,
  eventType: string,
  classified: ClassifiedEvent
): Promise<void> {
  if (!isAlertUrgency(classified.urgency)) {
    return
  }

  await client.createPage({
    parent: { database_id: databaseId },
    properties: {
      Date: { date: { start: new Date().toISOString() } },
      Provider: richText(provider),
      'Event Type': richText(eventType.slice(0, MAX_EVENT_TYPE_LENGTH)),
      Summary: richText(classified.summary),
      Urgency: { select: { name: classified.urgency } },
      Status: { select: { name: 'new' } },
      'Event ID': richText(eventId),
    },
  })
}

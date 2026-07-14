import type { ClassifiedEvent } from '../processing/classifier.js'
import { isAlertUrgency } from './urgency.js'

export interface SlackClient {
  postMessage(payload: unknown): Promise<void>
}

const FETCH_TIMEOUT_MS = 5000

// Real HTTP client for a Slack Incoming Webhook URL. Kept separate from
// SlackClient (the interface) so tests inject a mock instead of exercising
// a real network call — matches the "mocked clients only, real creds wired
// later" decision for P3.4.
export class HttpSlackClient implements SlackClient {
  constructor(private readonly webhookUrl: string) {}

  async postMessage(payload: unknown): Promise<void> {
    let response: Response
    try {
      response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
    } catch {
      // Never surface fetch()'s own error message: on a malformed URL,
      // Node's fetch (undici) embeds the full input URL — including this
      // webhook's secret path — in the thrown error, which would otherwise
      // flow into recordRoutingError and get persisted to Postgres.
      throw new Error('Slack webhook request failed')
    }
    if (!response.ok) {
      throw new Error(`Slack webhook failed: ${response.status}`)
    }
  }
}

// Slack attachment colors are hex strings, not the 🔴/🟠 emoji from the
// blueprint spec — Slack renders the colored bar from this field itself.
const URGENCY_COLOR: Record<'critical' | 'high', string> = {
  critical: '#e01e5a',
  high: '#ecb22e',
}

// Attachment `fields[].value` renders as plain text by default (mrkdwn_in
// is never set here), so this isn't exploitable today — but the LLM-derived
// summary/suggested_actions ultimately trace back to attacker-influenced
// webhook content, so escaping Slack's markup metacharacters is cheap
// insurance against a future refactor (e.g. enabling mrkdwn_in) turning
// that into link/formatting injection in an on-call channel.
function escapeSlackText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function routeToSlack(
  client: SlackClient,
  eventId: string,
  provider: string,
  classified: ClassifiedEvent
): Promise<void> {
  if (!isAlertUrgency(classified.urgency)) {
    return
  }

  await client.postMessage({
    attachments: [
      {
        color: URGENCY_COLOR[classified.urgency],
        fields: [
          { title: 'Provider', value: provider, short: true },
          { title: 'Urgency', value: classified.urgency, short: true },
          { title: 'Summary', value: escapeSlackText(classified.summary) },
          {
            title: 'Suggested actions',
            value: escapeSlackText(classified.suggested_actions.join('; ')),
          },
          { title: 'Event ID', value: eventId },
        ],
      },
    ],
  })
}

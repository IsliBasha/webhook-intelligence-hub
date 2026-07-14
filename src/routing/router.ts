import type { ClassifiedEvent } from '../processing/classifier.js'
import { routeToSlack } from './slack-router.js'
import type { SlackClient } from './slack-router.js'
import { routeToNotion } from './notion-router.js'
import type { NotionClient } from './notion-router.js'

export interface RouterDeps {
  slackClient: SlackClient | undefined
  notion: { client: NotionClient; databaseId: string } | undefined
  recordRoutingError: (eventId: string, error: string) => Promise<void>
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

// PostgreSQL persistence already happened in pipeline.ts's markProcessed
// before this is called — critical/high events additionally fan out to
// Slack and Notion (normal/low events stay Postgres-only, per the P3
// blueprint). Slack and Notion are independent side channels: one being
// unconfigured or failing must never block the other, and neither may fail
// the webhook ack, since the event is already durably stored either way.
// Failures are recorded on the row (not thrown) so they're visible on the
// dashboard instead of being silently dropped.
export async function routeEvent(
  eventId: string,
  provider: string,
  eventType: string,
  classified: ClassifiedEvent,
  deps: RouterDeps
): Promise<void> {
  const attempts: Array<{ channel: string; promise: Promise<void> }> = []

  if (deps.slackClient) {
    attempts.push({
      channel: 'Slack',
      promise: routeToSlack(deps.slackClient, eventId, provider, classified),
    })
  }
  if (deps.notion) {
    attempts.push({
      channel: 'Notion',
      promise: routeToNotion(
        deps.notion.client,
        deps.notion.databaseId,
        eventId,
        provider,
        eventType,
        classified
      ),
    })
  }

  const results = await Promise.allSettled(attempts.map((attempt) => attempt.promise))
  const failures = results
    .map((result, index) => ({ result, channel: attempts[index].channel }))
    .filter((entry): entry is { result: PromiseRejectedResult; channel: string } => entry.result.status === 'rejected')

  if (failures.length > 0) {
    const combined = failures
      .map((failure) => `${failure.channel}: ${errorMessage(failure.result.reason)}`)
      .join(' | ')
    try {
      await deps.recordRoutingError(eventId, combined)
    } catch {
      // Best-effort bookkeeping only. The event is already durably stored
      // and classified; failing to persist *that notification also failed*
      // must not escalate into rejecting this function — that would break
      // the "never rejects" contract above and turn a transient DB blip
      // into a false webhook-delivery failure (see pipeline.ts).
    }
  }
}

import { HttpSlackClient } from './slack-router.js'
import { HttpNotionClient } from './notion-router.js'
import type { RouterDeps } from './router.js'

export interface RoutingErrorRecorder {
  recordRoutingError(eventId: string, error: string): Promise<void>
}

// Slack/Notion are optional outbound side channels, not required for the
// service to run — unlike DATABASE_URL (pool.ts), a missing webhook URL or
// token means "this channel isn't configured yet", not "misconfigured
// deployment", so this degrades gracefully instead of throwing at startup.
// Notion requires BOTH NOTION_TOKEN and NOTION_DATABASE_ID — a partially
// configured pair (e.g. token set, database id missing) leaves the channel
// disabled rather than attempting a call that would always fail.
export function buildRouterDeps(eventStore: RoutingErrorRecorder): RouterDeps {
  const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL
  const notionToken = process.env.NOTION_TOKEN
  const notionDatabaseId = process.env.NOTION_DATABASE_ID

  return {
    slackClient: slackWebhookUrl ? new HttpSlackClient(slackWebhookUrl) : undefined,
    notion:
      notionToken && notionDatabaseId
        ? { client: new HttpNotionClient(notionToken), databaseId: notionDatabaseId }
        : undefined,
    recordRoutingError: (eventId, error) => eventStore.recordRoutingError(eventId, error),
  }
}

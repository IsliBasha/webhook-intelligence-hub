import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpSlackClient } from './slack-router.js'
import { HttpNotionClient } from './notion-router.js'
import { buildRouterDeps } from './router-deps.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

function fakeEventStore() {
  return { recordRoutingError: vi.fn().mockResolvedValue(undefined) }
}

describe('buildRouterDeps', () => {
  it('leaves both channels undefined when no env vars are set', () => {
    vi.stubEnv('SLACK_WEBHOOK_URL', '')
    vi.stubEnv('NOTION_TOKEN', '')
    vi.stubEnv('NOTION_DATABASE_ID', '')

    const deps = buildRouterDeps(fakeEventStore())

    expect(deps.slackClient).toBeUndefined()
    expect(deps.notion).toBeUndefined()
  })

  it('builds a Slack client when SLACK_WEBHOOK_URL is set', () => {
    vi.stubEnv('SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/T/B/x')
    vi.stubEnv('NOTION_TOKEN', '')
    vi.stubEnv('NOTION_DATABASE_ID', '')

    const deps = buildRouterDeps(fakeEventStore())

    expect(deps.slackClient).toBeInstanceOf(HttpSlackClient)
    expect(deps.notion).toBeUndefined()
  })

  it('builds a Notion client only when BOTH NOTION_TOKEN and NOTION_DATABASE_ID are set', () => {
    vi.stubEnv('SLACK_WEBHOOK_URL', '')
    vi.stubEnv('NOTION_TOKEN', 'secret_abc')
    vi.stubEnv('NOTION_DATABASE_ID', 'db-123')

    const deps = buildRouterDeps(fakeEventStore())

    expect(deps.notion?.client).toBeInstanceOf(HttpNotionClient)
    expect(deps.notion?.databaseId).toBe('db-123')
  })

  it('leaves Notion undefined when NOTION_TOKEN is set but NOTION_DATABASE_ID is missing', () => {
    vi.stubEnv('NOTION_TOKEN', 'secret_abc')
    vi.stubEnv('NOTION_DATABASE_ID', '')

    const deps = buildRouterDeps(fakeEventStore())

    expect(deps.notion).toBeUndefined()
  })

  it('leaves Notion undefined when NOTION_DATABASE_ID is set but NOTION_TOKEN is missing', () => {
    vi.stubEnv('NOTION_TOKEN', '')
    vi.stubEnv('NOTION_DATABASE_ID', 'db-123')

    const deps = buildRouterDeps(fakeEventStore())

    expect(deps.notion).toBeUndefined()
  })

  it('delegates recordRoutingError to the given event store', async () => {
    const eventStore = fakeEventStore()
    const deps = buildRouterDeps(eventStore)

    await deps.recordRoutingError('evt-1', 'boom')

    expect(eventStore.recordRoutingError).toHaveBeenCalledWith('evt-1', 'boom')
  })
})

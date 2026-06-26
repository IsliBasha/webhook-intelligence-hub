import type { ClassifiedEvent } from '../processing/classifier.js'
import type { EventStore } from '../storage/event-store.js'

// TODO P3.4: critical/high -> Slack + Notion + PostgreSQL; normal/low -> PostgreSQL only
export async function routeEvent(
  _eventId: string,
  _classified: ClassifiedEvent,
  _store: EventStore
): Promise<void> {
  throw new Error('Not implemented')
}

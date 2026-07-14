import type { ClassifiedEvent } from '../processing/classifier.js'

// Single source of truth for which urgencies trigger outbound alerting.
// Previously duplicated independently in slack-router.ts and
// notion-router.ts — a future threshold change (e.g. also alerting on
// "normal") only needs to change this one place instead of risking the two
// channels silently drifting out of sync.
export const ALERT_URGENCIES = new Set<ClassifiedEvent['urgency']>(['critical', 'high'])

export function isAlertUrgency(
  urgency: ClassifiedEvent['urgency']
): urgency is 'critical' | 'high' {
  return ALERT_URGENCIES.has(urgency)
}

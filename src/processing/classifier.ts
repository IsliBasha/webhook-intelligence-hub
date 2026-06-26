import Anthropic from '@anthropic-ai/sdk'
import { z } from 'zod'
import { stripPii } from './pii-stripper.js'

export const ClassifiedEventSchema = z.object({
  urgency: z.enum(['critical', 'high', 'normal', 'low']),
  category: z.enum(['payment', 'deployment', 'alert', 'info', 'error']),
  summary: z.string().max(100),
  suggested_actions: z.array(z.string()).max(3),
})

export type ClassifiedEvent = z.infer<typeof ClassifiedEventSchema>

// TODO P3.2: Call claude-haiku-4-5-20251001 with sanitized payload
export async function classifyEvent(
  _provider: string,
  _eventType: string,
  payload: unknown
): Promise<ClassifiedEvent> {
  void stripPii(payload); void Anthropic; void ClassifiedEventSchema
  throw new Error('Not implemented')
}

export type WebhookHeaders = Record<string, string | string[] | undefined>

export function firstHeaderValue(header: string | string[] | undefined): string | undefined {
  return Array.isArray(header) ? header[0] : header
}

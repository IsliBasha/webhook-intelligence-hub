const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g
const IP_RE    = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const PHONE_RE = /\+?[\d\s\-().]{7,}/g

export function stripPii(payload: unknown): unknown {
  const json = JSON.stringify(payload)
  return JSON.parse(
    json
      .replace(EMAIL_RE, '[EMAIL]')
      .replace(IP_RE, '[IP]')
      .replace(PHONE_RE, '[PHONE]')
  )
}

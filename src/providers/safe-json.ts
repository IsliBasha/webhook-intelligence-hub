export function safeJsonParse(rawBody: Buffer): unknown {
  try {
    return JSON.parse(rawBody.toString('utf8'))
  } catch {
    return undefined
  }
}

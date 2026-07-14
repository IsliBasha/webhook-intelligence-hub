const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g
const IP_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g

// Known secret/token formats (GitHub PATs, Stripe live keys, Anthropic keys,
// Slack tokens) that can appear embedded in free text — e.g. a token pasted
// into a commit message or PR body — where there's no labeled JSON key for
// redactSensitiveKeys below to catch it by field name.
const TOKEN_RE =
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|sk_live_[0-9a-zA-Z]{24,}|sk-ant-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g

// JSON keys whose value is always redacted regardless of shape — catches
// structured secrets (Stripe card metadata, a labeled api_key/token field)
// that the value-shape regexes above can't, since those only look at what a
// value looks like, not what field it's stored under.
const SENSITIVE_KEY_RE =
  /token|secret|password|api[_-]?key|authorization|card|ssn|cvv|account[_-]?number|routing[_-]?number/i

// Intentionally over-broad — see isLikelyPhoneNumber for the real filtering.
// The {5,} floor (7 total chars including the leading/trailing \d) is a
// coarse pre-filter roughly tracking MIN_PHONE_DIGITS below; the digit-count
// check in isLikelyPhoneNumber is the actual gate.
//
// Colon is included in the character class so a full "HH:MM:SS" run is
// captured as one candidate for isLikelyPhoneNumber to reject, instead of
// the match stopping mid-timestamp.
const PHONE_CANDIDATE_RE = /[+(]?\d[\d\s().:-]{5,}\d/g

// Bare date only (no time component). A candidate containing a colon (i.e.
// with a time part) is already rejected by the colon check in
// isLikelyPhoneNumber before this ever runs, so there's no need to also
// match time-bearing dates here.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

// Matches a bare decimal number like "1234.56" or "99999.00" — digits, a
// single dot, digits, nothing else.
const PLAIN_DECIMAL_RE = /^\d+\.\d+$/

const MIN_PHONE_DIGITS = 7
const MAX_PHONE_DIGITS = 15

// A phone number is dominated by digit *groups* separated by phone-style
// punctuation, in the realistic 7-15 digit range. Timestamps and bare
// decimals share the same punctuation alphabet, so they need their own
// explicit exclusions rather than a digit-count heuristic alone. Bare digit
// runs (long numeric IDs) are excluded because they carry no grouping
// structure at all.
function isLikelyPhoneNumber(candidate: string): boolean {
  if (candidate.includes(':')) return false // HH:MM:SS timestamps, never phone numbers
  if (ISO_DATE_RE.test(candidate)) return false
  if (PLAIN_DECIMAL_RE.test(candidate)) return false

  const digitCount = candidate.replace(/\D/g, '').length
  if (digitCount < MIN_PHONE_DIGITS || digitCount > MAX_PHONE_DIGITS) return false

  const hasGrouping = /[\s().-]/.test(candidate)
  if (!hasGrouping) return false // bare digit runs are IDs, not phone numbers

  return true
}

function redactPhoneNumbers(text: string): string {
  return text.replace(PHONE_CANDIDATE_RE, (match) => (isLikelyPhoneNumber(match) ? '[PHONE]' : match))
}

// Redacts by field name regardless of value shape/type — the only reliable
// way to catch structured secrets like Stripe card metadata or a labeled
// api_key field, neither of which has a text shape a value-based regex
// could recognize.
function redactSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveKeys)
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, val]) => [
        key,
        SENSITIVE_KEY_RE.test(key) ? '[REDACTED]' : redactSensitiveKeys(val),
      ])
    )
  }
  return value
}

/**
 * Known limitation: catches emails, IPs, phone numbers, known secret/token
 * formats, and any value under a sensitive-sounding key name. Does NOT
 * catch names, physical addresses, or other PII with no reliable text
 * pattern — that requires an NER pass, out of scope here.
 */
export function stripPii(payload: unknown): unknown {
  const keyRedacted = redactSensitiveKeys(payload)
  const json = JSON.stringify(keyRedacted)
  return JSON.parse(
    redactPhoneNumbers(json.replace(EMAIL_RE, '[EMAIL]').replace(IP_RE, '[IP]').replace(TOKEN_RE, '[TOKEN]'))
  )
}

import { describe, expect, it } from 'vitest'
import { stripPii } from './pii-stripper.js'

describe('stripPii', () => {
  describe('emails', () => {
    it('redacts an email address', () => {
      const result = stripPii({ contact: 'jane.doe@example.com' })

      expect(result).toEqual({ contact: '[EMAIL]' })
    })

    it('redacts multiple email addresses in nested fields', () => {
      const result = stripPii({
        sender: 'alice+billing@sub.example.co.uk',
        recipients: ['bob@example.com', 'carol@example.org'],
      })

      expect(result).toEqual({
        sender: '[EMAIL]',
        recipients: ['[EMAIL]', '[EMAIL]'],
      })
    })
  })

  describe('IP addresses', () => {
    it('redacts an IPv4 address', () => {
      const result = stripPii({ client_ip: '203.0.113.42' })

      expect(result).toEqual({ client_ip: '[IP]' })
    })

    it('redacts an IP address embedded in a longer string', () => {
      const result = stripPii({ note: 'request came from 192.168.1.100 via proxy' })

      expect(result).toEqual({ note: 'request came from [IP] via proxy' })
    })
  })

  describe('phone numbers — must be redacted', () => {
    it('redacts a US-style number with a country code and dashes', () => {
      const result = stripPii({ phone: '+1-555-123-4567' })

      expect(result).toEqual({ phone: '[PHONE]' })
    })

    it('redacts a US-style number with parens and a dash', () => {
      const result = stripPii({ phone: '(555) 123-4567' })

      expect(result).toEqual({ phone: '[PHONE]' })
    })

    it('redacts a dot-separated number', () => {
      const result = stripPii({ phone: '555.123.4567' })

      expect(result).toEqual({ phone: '[PHONE]' })
    })

    it('redacts an international number with spaces', () => {
      const result = stripPii({ phone: '+44 20 7946 0958' })

      expect(result).toEqual({ phone: '[PHONE]' })
    })

    it('redacts a phone number embedded in a sentence', () => {
      const result = stripPii({ note: 'call me at (555) 123-4567 tomorrow' })

      expect(result).toEqual({ note: 'call me at [PHONE] tomorrow' })
    })
  })

  describe('false positives that must NOT be redacted', () => {
    it('leaves a bare ISO date untouched', () => {
      const result = stripPii({ date: '2026-01-15' })

      expect(result).toEqual({ date: '2026-01-15' })
    })

    it('leaves an ISO date with a space-separated time untouched', () => {
      const result = stripPii({ timestamp: '2026-01-15 10:30:00' })

      expect(result).toEqual({ timestamp: '2026-01-15 10:30:00' })
    })

    it('leaves an ISO 8601 date-time with a T separator and Z offset untouched', () => {
      const result = stripPii({ created_at: '2026-01-15T10:30:00Z' })

      expect(result).toEqual({ created_at: '2026-01-15T10:30:00Z' })
    })

    it('leaves a plain decimal amount untouched', () => {
      const result = stripPii({ amount: '1234.56' })

      expect(result).toEqual({ amount: '1234.56' })
    })

    it('leaves a decimal amount with exactly 7 digits untouched', () => {
      // 99999.00 has 7 total digits, right at the phone-number digit floor —
      // must still be recognized as a decimal, not a phone number.
      const result = stripPii({ total: '99999.00' })

      expect(result).toEqual({ total: '99999.00' })
    })

    it('leaves a long numeric ID untouched', () => {
      const result = stripPii({ order_id: '1234567890' })

      expect(result).toEqual({ order_id: '1234567890' })
    })

    it('leaves numeric (non-string) fields untouched entirely', () => {
      const result = stripPii({ amount: 1234.56, order_id: 1234567890 })

      expect(result).toEqual({ amount: 1234.56, order_id: 1234567890 })
    })

    it('leaves a grouped-digit string below the phone digit floor untouched', () => {
      // Grouped like a phone number, but only 5 digits total — too short to
      // be a realistic phone number.
      const result = stripPii({ code: '1-2-3-4-5' })

      expect(result).toEqual({ code: '1-2-3-4-5' })
    })

    it('leaves a grouped-digit string above the phone digit ceiling untouched', () => {
      // Grouped like a phone number, but 19 digits total — too long to be a
      // realistic phone number (e.g. a long structured reference number).
      const result = stripPii({ code: '1234-5678-9012-3456-789' })

      expect(result).toEqual({ code: '1234-5678-9012-3456-789' })
    })
  })

  describe('structured secrets — redacted by key name regardless of value shape', () => {
    it('redacts a card metadata object under a "card" key', () => {
      const result = stripPii({ card: { last4: '4242', brand: 'visa', exp_month: 12 } })

      expect(result).toEqual({ card: '[REDACTED]' })
    })

    it('redacts a labeled api_key field', () => {
      const result = stripPii({ api_key: 'anything-at-all' })

      expect(result).toEqual({ api_key: '[REDACTED]' })
    })

    it('redacts a labeled token field nested inside another object', () => {
      const result = stripPii({ auth: { access_token: 'anything-at-all' } })

      expect(result).toEqual({ auth: { access_token: '[REDACTED]' } })
    })

    it('redacts an ssn field even though its value would not match any text regex', () => {
      const result = stripPii({ ssn: '123456789' })

      expect(result).toEqual({ ssn: '[REDACTED]' })
    })

    it('redacts sensitive keys inside array elements', () => {
      const result = stripPii({ items: [{ secret: 'x' }, { note: 'fine' }] })

      expect(result).toEqual({ items: [{ secret: '[REDACTED]' }, { note: 'fine' }] })
    })

    it('leaves a benign key untouched', () => {
      const result = stripPii({ description: 'a perfectly normal field' })

      expect(result).toEqual({ description: 'a perfectly normal field' })
    })
  })

  describe('known secret/token formats embedded in free text', () => {
    it('redacts a GitHub personal access token', () => {
      // Built via concatenation, not a literal: GitHub's own push-protection
      // secret scanner does static text matching against the source, so any
      // unbroken 36+ character run directly after "ghp_" trips it even when
      // the value is an obviously-fake placeholder (it isn't checksum-
      // validated the way GitHub's own real token issuance is). Splitting
      // the literal in two means the source never contains a matching run,
      // while stripPii still receives — and must still redact — the full
      // concatenated string at runtime, so the test still exercises the
      // real regex.
      const fakeGithubToken = 'ghp_' + 'FAKE'.repeat(9)
      const result = stripPii({
        commit_message: `oops committed ${fakeGithubToken} by accident`,
      })

      expect(result).toEqual({
        commit_message: 'oops committed [TOKEN] by accident',
      })
    })

    it('redacts a Stripe live secret key embedded in text', () => {
      // Same reasoning as the GitHub PAT fixture above.
      const fakeStripeKey = 'sk_live_' + 'FAKE'.repeat(6)
      const result = stripPii({
        note: `found ${fakeStripeKey} in logs`,
      })

      expect(result).toEqual({ note: 'found [TOKEN] in logs' })
    })
  })

  describe('combined realistic payload', () => {
    it('redacts PII and preserves everything else in a mixed webhook-shaped payload', () => {
      const payload = {
        event_type: 'order.created',
        created_at: '2026-01-15T10:30:00Z',
        customer: {
          email: 'jane.doe@example.com',
          phone: '+1-555-123-4567',
          ip_address: '203.0.113.42',
        },
        order: {
          id: 1234567890,
          total: '1234.56',
          placed_at: '2026-01-15 10:30:00',
        },
      }

      const result = stripPii(payload)

      expect(result).toEqual({
        event_type: 'order.created',
        created_at: '2026-01-15T10:30:00Z',
        customer: {
          email: '[EMAIL]',
          phone: '[PHONE]',
          ip_address: '[IP]',
        },
        order: {
          id: 1234567890,
          total: '1234.56',
          placed_at: '2026-01-15 10:30:00',
        },
      })
    })
  })
})

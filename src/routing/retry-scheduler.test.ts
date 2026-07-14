import { describe, expect, it, vi } from 'vitest'
import { processRetryQueue } from './retry-scheduler.js'

function fakeEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'evt-1',
    provider: 'github',
    event_type: 'push',
    raw_payload: { hello: 'world' },
    ...overrides,
  }
}

describe('processRetryQueue', () => {
  it('reprocesses every eligible event with its id/provider/event_type/raw_payload', async () => {
    const claimForRetry = vi.fn().mockResolvedValue([fakeEvent()])
    const reprocess = vi.fn().mockResolvedValue(undefined)

    const result = await processRetryQueue({ claimForRetry }, reprocess)

    expect(reprocess).toHaveBeenCalledWith('evt-1', 'github', 'push', { hello: 'world' })
    expect(result).toEqual({ attempted: 1, failed: 0 })
  })

  it('reprocesses multiple eligible events', async () => {
    const claimForRetry = vi.fn().mockResolvedValue([
      fakeEvent({ id: 'evt-1' }),
      fakeEvent({ id: 'evt-2' }),
      fakeEvent({ id: 'evt-3' }),
    ])
    const reprocess = vi.fn().mockResolvedValue(undefined)

    const result = await processRetryQueue({ claimForRetry }, reprocess)

    expect(reprocess).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ attempted: 3, failed: 0 })
  })

  it('returns attempted: 0 when nothing is eligible, without calling reprocess', async () => {
    const claimForRetry = vi.fn().mockResolvedValue([])
    const reprocess = vi.fn()

    const result = await processRetryQueue({ claimForRetry }, reprocess)

    expect(reprocess).not.toHaveBeenCalled()
    expect(result).toEqual({ attempted: 0, failed: 0 })
  })

  it('one event failing to reprocess does not stop the others in the same sweep', async () => {
    const claimForRetry = vi.fn().mockResolvedValue([
      fakeEvent({ id: 'evt-1' }),
      fakeEvent({ id: 'evt-2' }),
    ])
    const reprocess = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)

    const result = await processRetryQueue({ claimForRetry }, reprocess)

    expect(reprocess).toHaveBeenCalledTimes(2)
    expect(result).toEqual({ attempted: 2, failed: 1 })
  })

  it('passes maxAttempts through to claimForRetry', async () => {
    const claimForRetry = vi.fn().mockResolvedValue([])

    await processRetryQueue({ claimForRetry }, vi.fn(), 3)

    expect(claimForRetry).toHaveBeenCalledWith(3)
  })

  it('calls claimForRetry with undefined when maxAttempts is not given, letting EventStore apply its own default', async () => {
    const claimForRetry = vi.fn().mockResolvedValue([])

    await processRetryQueue({ claimForRetry }, vi.fn())

    expect(claimForRetry).toHaveBeenCalledWith(undefined)
  })
})

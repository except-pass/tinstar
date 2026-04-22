import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { TelemetryQuery } from '../query.js'

describe('TelemetryQuery.burningSessions', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = vi.fn() as any
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('returns the set of session_ids with non-zero token rate', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            { metric: { session_id: 'uuid-a' }, value: [1700000000, '42.5'] },
            { metric: { session_id: 'uuid-b' }, value: [1700000000, '8.1'] },
          ],
        },
      }),
    })

    const q = new TelemetryQuery('http://fake')
    const result = await q.burningSessions({ userEmail: 'x@example.com' })

    expect(result).toEqual(['uuid-a', 'uuid-b'])
    expect((global.fetch as any).mock.calls.length).toBe(1)
    const url = (global.fetch as any).mock.calls[0][0] as string
    expect(url).toContain('rate(claude_code_token_usage_tokens_total')
    expect(url).toContain('user_email%3D%22x%40example.com%22') // url-encoded
  })

  it('returns empty array when no series match', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'success', data: { resultType: 'vector', result: [] } }),
    })
    const q = new TelemetryQuery('http://fake')
    expect(await q.burningSessions({ userEmail: 'x@example.com' })).toEqual([])
  })

  it('skips series that lack a session_id label', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [
            { metric: {}, value: [1700000000, '1'] },
            { metric: { session_id: 'uuid-c' }, value: [1700000000, '2'] },
          ],
        },
      }),
    })
    const q = new TelemetryQuery('http://fake')
    expect(await q.burningSessions({ userEmail: 'x@example.com' })).toEqual(['uuid-c'])
  })

  it('throws on non-success Prometheus response', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: 'error', error: 'boom' }),
    })
    const q = new TelemetryQuery('http://fake')
    await expect(q.burningSessions({ userEmail: 'x@example.com' })).rejects.toThrow(/boom/)
  })
})

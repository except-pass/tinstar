// @vitest-environment jsdom
import { render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetProviderTelemetrySeriesForTests,
  useProviderTelemetrySeries,
} from '../useProviderTelemetrySeries'

function Probe({
  onValue,
  providerId = 'codex',
  sessionId = 'run-1',
}: {
  onValue: (value: unknown) => void
  providerId?: string
  sessionId?: string
}) {
  onValue(useProviderTelemetrySeries(providerId, sessionId))
  return null
}

describe('useProviderTelemetrySeries', () => {
  beforeEach(() => {
    _resetProviderTelemetrySeriesForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shares one history fetch and maps native token points for every subscriber', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      kind: 'historical-telemetry',
      providerId: 'codex',
      scope: { kind: 'session', sessionId: 'run-1' },
      source: { id: 'provider-metrics', label: 'Tinstar provider observation history' },
      freshness: {
        state: 'fresh',
        observedAt: '2026-08-01T12:00:00.000Z',
        checkedAt: '2026-08-01T12:00:00.000Z',
      },
      availability: {
        state: 'available',
        value: {
          series: [{
            metric: 'tokens',
            unit: 'tokens',
            points: [
              { at: '2026-08-01T11:59:55.000Z', value: 1_000 },
              { at: '2026-08-01T12:00:00.000Z', value: 1_200 },
            ],
          }],
        },
      },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const first: unknown[] = []
    const second: unknown[] = []

    render(<>
      <Probe onValue={value => first.push(value)} />
      <Probe onValue={value => second.push(value)} />
    </>)

    await waitFor(() => {
      expect(first.at(-1)).toMatchObject({ tokens: [1_000, 1_200], freshness: 'fresh' })
      expect(second.at(-1)).toMatchObject({ tokens: [1_000, 1_200], freshness: 'fresh' })
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('exposes unavailable history as an error with empty series, not zero samples', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      kind: 'historical-telemetry',
      providerId: 'codex',
      scope: { kind: 'session', sessionId: 'run-1' },
      source: { id: 'provider-metrics', label: 'Tinstar provider observation history' },
      freshness: {
        state: 'unknown',
        observedAt: null,
        checkedAt: '2026-08-01T12:00:00.000Z',
      },
      availability: {
        state: 'unavailable',
        reason: 'temporarily-unavailable',
        message: 'Provider history is not ready',
      },
    }), { status: 200 })))
    const values: unknown[] = []

    render(<Probe onValue={value => values.push(value)} />)

    await waitFor(() => {
      expect(values.at(-1)).toMatchObject({
        tokens: [],
        error: 'Provider history is not ready',
      })
    })
  })

  it('never returns the prior session snapshot during a key change render', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('run-2')) {
        return await new Promise<Response>(() => {})
      }
      return new Response(JSON.stringify({
        kind: 'historical-telemetry',
        providerId: 'codex',
        scope: { kind: 'session', sessionId: 'run-1' },
        source: { id: 'provider-metrics', label: 'History' },
        freshness: {
          state: 'fresh',
          observedAt: '2026-08-01T12:00:00.000Z',
          checkedAt: '2026-08-01T12:00:00.000Z',
        },
        availability: {
          state: 'available',
          value: {
            series: [{
              metric: 'tokens',
              unit: 'tokens',
              points: [{ at: '2026-08-01T12:00:00.000Z', value: 1_200 }],
            }],
          },
        },
      }), { status: 200 })
    }))
    const values: unknown[] = []
    const view = render(<Probe onValue={value => values.push(value)} />)

    await waitFor(() => expect(values.at(-1)).toMatchObject({ tokens: [1_200] }))
    const keyChangeStart = values.length
    view.rerender(<Probe sessionId="run-2" onValue={value => values.push(value)} />)

    expect(values.slice(keyChangeStart)).not.toContainEqual(
      expect.objectContaining({ tokens: [1_200] }),
    )
    expect(values.at(-1)).toBeNull()
  })
})

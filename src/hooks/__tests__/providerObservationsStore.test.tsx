// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetProviderObservationsStoreForTests,
  useProviderObservations,
  useProviderQuotaObservations,
  useProviderSessionObservationState,
} from '../providerObservationsStore'

function Probe({ sessionId, onValue }: {
  sessionId: string
  onValue: (value: unknown) => void
}) {
  const current = useProviderObservations()
  const sessionState = useProviderSessionObservationState(sessionId)
  const quota = useProviderQuotaObservations()
  onValue({ current, session: sessionState.observations, sessionState, quota })
  return null
}

function wire() {
  const observations = {
    version: 1 as const,
    sessionUsage: [{
      kind: 'session-usage' as const,
      providerId: 'codex',
      scope: { kind: 'session' as const, sessionId: 'run-1' },
      source: { id: 'rollout', label: 'Codex rollout' },
      freshness: {
        state: 'fresh' as const,
        observedAt: '2026-08-01T12:00:00.000Z',
        checkedAt: '2026-08-01T12:00:00.000Z',
      },
      availability: {
        state: 'available' as const,
        value: { model: 'gpt-5.4', cumulativeTokens: { total: 1_200 } },
      },
    }],
    sessionContext: [{
      kind: 'session-context' as const,
      providerId: 'codex',
      scope: { kind: 'session' as const, sessionId: 'run-1' },
      source: { id: 'rollout', label: 'Codex rollout' },
      freshness: {
        state: 'fresh' as const,
        observedAt: '2026-08-01T12:00:00.000Z',
        checkedAt: '2026-08-01T12:00:00.000Z',
      },
      availability: {
        state: 'available' as const,
        value: { usedPercent: 37, windowTokens: 200_000 },
      },
    }],
    providerQuota: [{
      kind: 'provider-quota' as const,
      providerId: 'codex',
      scope: { kind: 'provider' as const, accountRef: 'default' },
      source: { id: 'rollout', label: 'Codex rollout' },
      freshness: {
        state: 'fresh' as const,
        observedAt: '2026-08-01T12:00:00.000Z',
        checkedAt: '2026-08-01T12:00:00.000Z',
      },
      availability: { state: 'available' as const, value: { windows: [] } },
    }],
  }
  return {
    version: 1 as const,
    observations,
    managedSessions: [{
      hostSessionId: 'run-1',
      providerId: 'codex',
      providerSessionIds: ['run-1'],
    }],
  }
}

describe('provider observations store', () => {
  beforeEach(() => {
    _resetProviderObservationsStoreForTests()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('polls once for all consumers and selects provider-partitioned session and quota data', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(wire()), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const values: unknown[] = []

    render(<Probe sessionId="run-1" onValue={value => values.push(value)} />)

    await waitFor(() => {
      const value = values.at(-1) as {
        current: { loaded: boolean }
        session: Array<{ providerId: string; usage?: unknown; context?: unknown }>
        quota: { observations: unknown[] }
      }
      expect(value.current.loaded).toBe(true)
      expect(value.session).toMatchObject([{
        providerId: 'codex',
        usage: { availability: { value: { model: 'gpt-5.4' } } },
        context: { availability: { value: { usedPercent: 37 } } },
      }])
      expect(value.quota.observations).toHaveLength(1)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => { vi.advanceTimersByTime(1_500) })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('keeps the last validated snapshot and exposes an error when refresh data is invalid', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(wire()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: 1 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const values: unknown[] = []

    render(<Probe sessionId="run-1" onValue={value => values.push(value)} />)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    await act(async () => { vi.advanceTimersByTime(1_500) })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const value = values.at(-1) as {
      current: { error: string | null }
      session: Array<{ providerId: string }>
      sessionState: { error: string | null }
    }
    expect(value.current.error).toMatch(/Required|expected|invalid_type/i)
    expect(value.sessionState.error).toMatch(/Required|expected|invalid_type/i)
    expect(value.session).toEqual([expect.objectContaining({ providerId: 'codex' })])
  })

  it('joins provider-native session IDs through provider-fenced managed aliases', async () => {
    const response = wire()
    response.observations.sessionUsage[0]!.scope.sessionId = 'claude-conversation-1'
    response.observations.sessionUsage[0]!.providerId = 'claude'
    response.observations.sessionContext[0]!.scope.sessionId = 'claude-conversation-1'
    response.observations.sessionContext[0]!.providerId = 'claude'
    response.managedSessions = [{
      hostSessionId: 'run-1',
      providerId: 'claude',
      providerSessionIds: ['run-1', 'claude-conversation-1'],
    }]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })))
    const values: unknown[] = []

    render(<Probe sessionId="run-1" onValue={value => values.push(value)} />)

    await waitFor(() => {
      const value = values.at(-1) as { session: Array<{ providerId: string }> }
      expect(value.session).toEqual([expect.objectContaining({ providerId: 'claude' })])
    })
  })

  it('does not join an alias owned by a different provider', async () => {
    const response = wire()
    response.managedSessions = [{
      hostSessionId: 'run-1',
      providerId: 'claude',
      providerSessionIds: ['run-1', 'claude-native-id'],
    }]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })))
    const values: unknown[] = []

    render(<Probe sessionId="run-1" onValue={value => values.push(value)} />)

    await waitFor(() => {
      const value = values.at(-1) as { current: { loaded: boolean }; session: unknown[] }
      expect(value.current.loaded).toBe(true)
      expect(value.session).toEqual([])
    })
  })
})

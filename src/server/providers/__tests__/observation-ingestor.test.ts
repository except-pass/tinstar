import { describe, expect, it, vi } from 'vitest'
import { ProviderObservationIngestor } from '../observation-ingestor'
import { ProviderCurrentObservationStores } from '../observation-stores'

const EVENT = {
  id: 'event-1',
  observedAt: '2026-08-01T12:00:00.000Z',
  replayed: true,
  sessionUsage: {
    model: 'gpt-5.4',
    cumulativeTokens: { input: 700, output: 300, total: 1_000 },
    latestTurnTokens: { input: 70, output: 30, total: 100 },
  },
  sessionContext: {
    usedTokens: 90,
    windowTokens: 1_000,
    usedPercent: 9,
  },
  providerQuota: {
    windows: [{
      id: 'primary',
      label: 'Primary',
      windowMinutes: 300,
      usedPercent: 25,
      resetsAt: '2026-08-01T13:00:00.000Z',
    }],
  },
} as const

describe('ProviderObservationIngestor', () => {
  it('hydrates current provider-neutral stores from replay without duplicating history', () => {
    const stores = new ProviderCurrentObservationStores()
    const sink = { pushMetric: vi.fn() }
    const ingestor = new ProviderObservationIngestor({
      stores,
      sink,
      now: () => Date.parse('2026-08-01T12:00:01.000Z'),
    })

    ingestor.ingest({
      providerId: 'codex',
      sessionId: 'worker',
      accountRef: 'default',
      source: { id: 'rollout', label: 'Codex rollout' },
      event: EVENT,
    })

    expect(stores.sessions.getUsage('codex', 'worker')).toMatchObject({
      availability: { value: { model: 'gpt-5.4', cumulativeTokens: { total: 1_000 } } },
    })
    expect(stores.sessions.getContext('codex', 'worker')).toMatchObject({
      availability: { value: { usedPercent: 9 } },
    })
    expect(stores.quotas.get('codex', 'default')).toMatchObject({
      availability: { value: { windows: [{ id: 'primary', usedPercent: 25 }] } },
    })
    expect(sink.pushMetric).not.toHaveBeenCalled()
  })

  it('emits provider-labelled historical gauges only for incremental events', () => {
    const stores = new ProviderCurrentObservationStores()
    const sink = { pushMetric: vi.fn() }
    const ingestor = new ProviderObservationIngestor({ stores, sink })

    ingestor.ingest({
      providerId: 'forge',
      sessionId: 'worker',
      accountRef: 'account-a',
      source: { id: 'native-events', label: 'Native events' },
      event: { ...EVENT, replayed: false },
    })

    expect(sink.pushMetric).toHaveBeenCalledWith(expect.objectContaining({
      name: 'tinstar_provider_session_tokens',
      type: 'gauge',
      value: 1_000,
      timestamp: EVENT.observedAt,
      labels: expect.objectContaining({
        provider: 'forge',
        session: 'worker',
        aggregation: 'cumulative',
        token: 'total',
        model: 'gpt-5.4',
      }),
    }))
    expect(sink.pushMetric).toHaveBeenCalledWith(expect.objectContaining({
      name: 'tinstar_provider_quota_used_ratio',
      value: 0.25,
      labels: expect.objectContaining({
        provider: 'forge',
        account: 'account-a',
        window: 'primary',
      }),
    }))
  })

  it('clears only session-scoped current state on incarnation cleanup', () => {
    const stores = new ProviderCurrentObservationStores()
    const ingestor = new ProviderObservationIngestor({ stores })
    ingestor.ingest({
      providerId: 'codex',
      sessionId: 'worker',
      accountRef: 'default',
      source: { id: 'rollout', label: 'Codex rollout' },
      event: EVENT,
    })

    ingestor.clearSession('codex', 'worker')

    expect(stores.sessions.getUsage('codex', 'worker')).toBeUndefined()
    expect(stores.sessions.getContext('codex', 'worker')).toBeUndefined()
    expect(stores.quotas.get('codex', 'default')).toBeDefined()
  })
})

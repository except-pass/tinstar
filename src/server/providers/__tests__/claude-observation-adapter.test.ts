import { describe, expect, it, vi } from 'vitest'
import type { Metric } from '../../types'
import { ProviderCurrentObservationStores } from '../observation-stores'
import { createClaudeObservationAdapter } from '../claude-observation-adapter'
import { createDefaultProviderRegistry } from '../lifecycle'

describe('Claude observation adapter', () => {
  it('owns statusline current state while preserving Prometheus history and context detail', async () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z')
    const metrics: Metric[] = []
    const telemetry = {
      todayHud: vi.fn(async () => ({
        window: 'today' as const,
        state: 'ready' as const,
        cost: { total: 1.25, byModel: { sonnet: 1.25 } },
        tokens: { total: 1200 },
        rate: { perMin: 20, perHour: 900 },
        cacheHitPct: 0.4,
        dutyCycle: { value: 0.5, windowMinutes: 5 },
      })),
      burningSessions: vi.fn(async () => ['claude-conversation']),
      sessionSeries: vi.fn(async () => ({
        startedAt: '2026-08-01T11:55:00.000Z',
        endedAt: '2026-08-01T12:00:00.000Z',
        stepSec: 5,
        series: {
          cost: [[1_785_588_800, 1.25] as [number, number]],
          tokens: [[1_785_588_800, 1200] as [number, number]],
          cache: [[1_785_588_800, 0.4] as [number, number]],
          duty: [[1_785_588_800, 0.5] as [number, number]],
        },
      })),
    }
    const stores = new ProviderCurrentObservationStores({ now: () => now })
    stores.quotas.set({
      kind: 'provider-quota',
      providerId: 'forge',
      scope: { kind: 'provider', accountRef: 'default' },
      source: { id: 'native', label: 'Forge native' },
      freshness: {
        state: 'fresh',
        observedAt: '2026-08-01T11:59:00.000Z',
        checkedAt: '2026-08-01T11:59:00.000Z',
      },
      availability: {
        state: 'available',
        value: {
          windows: [{
            id: 'primary',
            label: 'Primary',
            windowMinutes: 60,
            usedPercent: 91,
          }],
        },
      },
    })
    const observations = createClaudeObservationAdapter({
      stores,
      sink: { pushMetric: metric => metrics.push(metric) },
      now: () => now,
      getTelemetryQuery: () => telemetry,
      getDefaultUserEmail: () => 'person@example.com',
      getDetailedContext: vi.fn(async () => ({
        categories: [{ name: 'system', tokens: 500, percentage: 25 }],
        totalTokens: 2_000,
        maxTokens: 200_000,
        percentage: 1,
        model: 'claude-sonnet',
        isAutoCompactEnabled: true,
        autoCompactThreshold: 80,
      })),
    })
    const registry = createDefaultProviderRegistry()
    registry.registerObservations(observations.adapter)
    expect(registry.requireObservations('claude')).toBe(observations.adapter)

    const legacy = observations.statusline.ingest({
      session_id: 'claude-conversation',
      model: { id: 'claude-sonnet' },
      context_window: {
        total_input_tokens: 1_000,
        total_output_tokens: 200,
        context_window_size: 200_000,
        used_percentage: 1,
      },
      rate_limits: {
        five_hour: { used_percentage: 40, resets_at: 1_785_588_800 },
      },
    })

    expect(legacy.data?.five_hour?.utilization).toBe(40)
    expect(stores.sessions.getUsage('claude', 'claude-conversation'))
      .toMatchObject({ source: { id: 'statusline' }, availability: { state: 'available' } })
    expect(stores.sessions.getContext('claude', 'claude-conversation'))
      .toMatchObject({ availability: { value: { usedPercent: 1, windowTokens: 200_000 } } })
    expect(stores.quotas.get('claude', 'default'))
      .toMatchObject({ availability: { value: { windows: [{ usedPercent: 40 }] } } })
    expect(stores.quotas.get('forge', 'default'))
      .toMatchObject({ availability: { value: { windows: [{ usedPercent: 91 }] } } })

    const historical = await observations.adapter.observe['historical-telemetry']({
      kind: 'historical-telemetry',
      scope: { kind: 'session', sessionId: 'claude-conversation' },
    })
    expect(historical).toMatchObject({
      providerId: 'claude',
      source: { id: 'prometheus' },
      availability: {
        state: 'available',
        value: {
          series: expect.arrayContaining([
            expect.objectContaining({ metric: 'cost' }),
            expect.objectContaining({ metric: 'tokens' }),
          ]),
        },
      },
    })

    const context = await observations.adapter.observe['context-breakdown']({
      kind: 'context-breakdown',
      scope: { kind: 'session', sessionId: 'claude-conversation' },
    })
    expect(context).toMatchObject({
      source: { id: 'control-protocol' },
      availability: {
        state: 'available',
        value: { categories: [{ id: 'system', label: 'system', tokens: 500 }] },
      },
      detail: { legacyContext: { model: 'claude-sonnet', isAutoCompactEnabled: true } },
    })

    expect(await observations.todayHud({
      userEmail: 'person@example.com',
      tzOffsetMinutes: 0,
    })).toMatchObject({
      cost: { total: 1.25 },
      tokens: { total: 1200 },
      cacheHitPct: 0.4,
      dutyCycle: { value: 0.5 },
    })
    expect(await observations.burningSessions({ userEmail: 'person@example.com' }))
      .toEqual(['claude-conversation'])

    expect(metrics.some(metric => metric.name === 'cc_quota_used_ratio')).toBe(true)
    expect(metrics.some(metric => metric.name.startsWith('tinstar_provider_'))).toBe(false)
  })

  it('never regresses statusline observation timestamps when the wall clock moves backward', () => {
    let now = Date.parse('2026-08-01T12:00:00.000Z')
    const stores = new ProviderCurrentObservationStores({ now: () => now })
    const observations = createClaudeObservationAdapter({
      stores,
      now: () => now,
      getTelemetryQuery: () => null,
      getDefaultUserEmail: () => '',
      getDetailedContext: async () => { throw new Error('unused') },
    })
    const payload = {
      session_id: 'claude-conversation',
      context_window: { context_window_size: 200_000, used_percentage: 10 },
      rate_limits: {
        five_hour: { used_percentage: 20, resets_at: 1_785_588_800 },
      },
    }
    observations.statusline.ingest(payload)
    const firstContextAt = stores.sessions
      .getContext('claude', 'claude-conversation')?.freshness.observedAt
    const firstQuotaAt = stores.quotas.get('claude', 'default')?.freshness.observedAt

    now -= 60_000
    observations.statusline.ingest({
      ...payload,
      context_window: { context_window_size: 200_000, used_percentage: 11 },
    })

    expect(stores.sessions.getContext('claude', 'claude-conversation')?.freshness.observedAt)
      .toBe(firstContextAt)
    expect(stores.quotas.get('claude', 'default')?.freshness.observedAt)
      .toBe(firstQuotaAt)
  })

  it('preserves cached Prometheus HUD age instead of reporting stale data as fresh', async () => {
    const now = Date.parse('2026-08-01T12:00:00.000Z')
    const stores = new ProviderCurrentObservationStores({ now: () => now })
    const observations = createClaudeObservationAdapter({
      stores,
      now: () => now,
      getTelemetryQuery: () => ({
        todayHud: vi.fn(async () => ({
          window: 'today' as const,
          state: 'ready' as const,
          cost: { total: 1.25, byModel: {} },
          tokens: { total: 1_200 },
          rate: { perMin: 20, perHour: 900 },
          cacheHitPct: 0.4,
          dutyCycle: { value: 0.5, windowMinutes: 5 },
          staleSeconds: 60,
        })),
        burningSessions: vi.fn(async () => []),
        sessionSeries: vi.fn(async () => { throw new Error('unused') }),
      }),
      getDefaultUserEmail: () => 'person@example.com',
      getDetailedContext: async () => { throw new Error('unused') },
    })

    const historical = await observations.adapter.observe['historical-telemetry']({
      kind: 'historical-telemetry',
      scope: { kind: 'provider', accountRef: 'default' },
    })

    expect(historical.freshness).toEqual({
      state: 'stale',
      observedAt: '2026-08-01T11:59:00.000Z',
      checkedAt: '2026-08-01T12:00:00.000Z',
    })
    expect(historical.availability.state).toBe('available')
    if (historical.availability.state === 'available') {
      for (const series of historical.availability.value.series) {
        expect(series.points).toEqual([
          expect.objectContaining({ at: '2026-08-01T11:59:00.000Z' }),
        ])
      }
    }
  })
})

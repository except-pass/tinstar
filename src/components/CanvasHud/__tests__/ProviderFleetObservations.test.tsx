// @vitest-environment jsdom
import { render, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ProviderCurrentObservationsWire } from '../../../domain/provider-observation-wire'
import { ProviderFleetObservations } from '../ProviderFleetObservations'

const base = {
  version: 1 as const,
  sessionContext: [],
  providerQuota: [],
}

describe('<ProviderFleetObservations>', () => {
  it('compares provider totals without converting unavailable data to zero', () => {
    const observations: ProviderCurrentObservationsWire = {
      ...base,
      sessionUsage: [
        usage('claude', 'claude-1', 1_000, 'claude-sonnet'),
        usage('codex', 'codex-1', 2_000, 'gpt-5.4'),
        {
          ...usage('codex', 'codex-2', 1, 'gpt-5.4'),
          availability: { state: 'unavailable', reason: 'not-observed' },
        },
        {
          ...usage('forge', 'forge-1', 1, 'forge-model'),
          availability: { state: 'unsupported', reason: 'No native usage API' },
          source: null,
          freshness: {
            state: 'unknown',
            observedAt: null,
            checkedAt: '2026-08-01T12:00:00.000Z',
          },
        },
      ],
    }

    const view = render(<ProviderFleetObservations observations={observations} />)

    expect(within(view.getByTestId('provider-fleet-row-claude')).getByText('1.0k tok')).toBeTruthy()
    expect(within(view.getByTestId('provider-fleet-row-codex')).getByText('2.0k tok')).toBeTruthy()
    expect(within(view.getByTestId('provider-fleet-row-codex')).getByText(/1 unavailable/)).toBeTruthy()
    expect(within(view.getByTestId('provider-fleet-row-forge')).getByText('unavailable')).toBeTruthy()
    expect(view.queryByText('0 tok')).toBeNull()
  })

  it('surfaces the native source and a refresh failure while preserving cached rows', () => {
    const observations: ProviderCurrentObservationsWire = {
      ...base,
      sessionUsage: [usage('codex', 'codex-1', 2_000, 'gpt-5.4')],
    }
    const view = render(
      <ProviderFleetObservations observations={observations} error="HTTP 503" />,
    )

    expect(view.getByText('refresh failed')).toBeTruthy()
    expect(view.getByTestId('provider-fleet-row-codex').title).toContain('Codex rollout')
  })

  it('uses latest-turn tokens when cumulative usage has only cache counters', () => {
    const partial = {
      ...usage('forge', 'forge-1', 1, 'forge-model'),
      availability: {
        state: 'available' as const,
        value: {
          model: 'forge-model',
          cumulativeTokens: { cacheRead: 500 },
          latestTurnTokens: { input: 7, output: 3 },
        },
      },
    }
    const observations: ProviderCurrentObservationsWire = {
      ...base,
      sessionUsage: [partial],
    }

    const view = render(<ProviderFleetObservations observations={observations} />)

    expect(within(view.getByTestId('provider-fleet-row-forge')).getByText('10 tok')).toBeTruthy()
  })
})

function usage(providerId: string, sessionId: string, total: number, model: string) {
  return {
    kind: 'session-usage' as const,
    providerId,
    scope: { kind: 'session' as const, sessionId },
    source: { id: 'native', label: `${providerId === 'codex' ? 'Codex rollout' : providerId} native` },
    freshness: {
      state: 'fresh' as const,
      observedAt: '2026-08-01T12:00:00.000Z',
      checkedAt: '2026-08-01T12:00:00.000Z',
    },
    availability: {
      state: 'available' as const,
      value: { model, cumulativeTokens: { total } },
    },
  }
}

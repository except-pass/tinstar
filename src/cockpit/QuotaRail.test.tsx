// @vitest-environment jsdom
import { render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CcQuotaSnapshot } from '../hooks/useCcQuota'
import { QuotaRail } from './QuotaRail'

const source = vi.hoisted(() => ({
  claude: null as CcQuotaSnapshot | null,
  provider: { observations: [], error: null, loaded: true },
}))
vi.mock('../hooks/useCcQuota', () => ({ useCcQuota: () => ({ snapshot: source.claude }) }))
vi.mock('../hooks/providerObservationsStore', () => ({ useProviderQuotaObservations: () => source.provider }))

afterEach(() => { source.claude = null })

describe('cockpit provider quota', () => {
  it('shows current Claude windows with reset time and freshness', () => {
    const now = Date.now()
    source.claude = {
      fetchedAt: new Date(now - 60_000).toISOString(), error: null,
      data: {
        five_hour: { utilization: 24, resets_at: new Date(now + 2 * 60 * 60_000).toISOString() },
        seven_day: { utilization: 61, resets_at: new Date(now + 3 * 24 * 60 * 60_000).toISOString() },
      },
    }
    const view = render(<QuotaRail />)
    const claude = within(view.getByRole('region', { name: 'Claude provider quota' }))
    expect(claude.getByText('5H · 76% left')).toBeTruthy()
    expect(claude.getByText('7D · 39% left')).toBeTruthy()
    expect(claude.getByText(/fresh · 1m ago/)).toBeTruthy()
    expect(claude.getAllByText(/resets/)).toHaveLength(2)
  })

  it('does not show cached percentages after the feed becomes stale', () => {
    const now = Date.now()
    source.claude = {
      fetchedAt: new Date(now - 10 * 60_000).toISOString(), error: null,
      data: {
        five_hour: { utilization: 0, resets_at: new Date(now + 60_000).toISOString() },
        seven_day: { utilization: 100, resets_at: new Date(now + 60_000).toISOString() },
      },
    }
    const view = render(<QuotaRail />)
    const claude = within(view.getByRole('region', { name: 'Claude provider quota' }))
    expect(claude.getByText(/stale · 10m ago/)).toBeTruthy()
    expect(claude.getAllByText(/unavailable/)).toHaveLength(2)
    expect(claude.queryByText(/0% left|100% left/)).toBeNull()
  })
})

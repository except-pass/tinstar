// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { CcQuotaCard } from '../CcQuotaCard'
import type { CcQuotaSnapshot } from '../../../hooks/useCcQuota'

function snap(partial: Partial<CcQuotaSnapshot['data']> = {}): CcQuotaSnapshot {
  return {
    fetchedAt: '2026-04-23T08:36:00.000Z',
    data: {
      five_hour:        { utilization: 67, resets_at: '2026-04-23T11:49:00.000Z' },
      seven_day:        { utilization: 89, resets_at: '2026-04-24T00:00:00.000Z' },
      seven_day_opus:   null,
      seven_day_sonnet: null,
      extra_usage:      { is_enabled: true, used_credits: 8148, currency: 'USD' },
      ...partial,
    },
    error: null,
  }
}

describe('<CcQuotaCard>', () => {
  it('renders % left for each bucket — NOT % used', () => {
    const { getByText, queryByText } = render(
      <CcQuotaCard snapshot={snap()} lastRefreshedAt={snap().fetchedAt} refreshing={false} refresh={() => {}} nowMs={Date.parse('2026-04-23T08:36:00Z')}/>
    )
    expect(getByText('33% left')).toBeTruthy()
    expect(getByText('11% left')).toBeTruthy()
    expect(queryByText(/67% used/)).toBeNull()
    expect(queryByText(/89% used/)).toBeNull()
  })

  it('shows gas pump ON with $X.XX when extra_usage is enabled', () => {
    const { getByText } = render(
      <CcQuotaCard snapshot={snap()} lastRefreshedAt={null} refreshing={false} refresh={() => {}} nowMs={Date.parse('2026-04-23T08:36:00Z')}/>
    )
    expect(getByText('$81.48')).toBeTruthy()
  })

  it('shows OFF when extra_usage.is_enabled=false', () => {
    const { getByText } = render(
      <CcQuotaCard snapshot={snap({ extra_usage: { is_enabled: false, used_credits: 0, currency: 'USD' } })} lastRefreshedAt={null} refreshing={false} refresh={() => {}}/>
    )
    expect(getByText('OFF')).toBeTruthy()
  })

  it('renders full skeleton with -- when snapshot has no data', () => {
    const empty: CcQuotaSnapshot = { fetchedAt: '2026-04-23T08:36:00.000Z', data: null, error: { code: 'no_creds', message: 'sign in' } }
    const { getAllByText, container } = render(
      <CcQuotaCard snapshot={empty} lastRefreshedAt={empty.fetchedAt} refreshing={false} refresh={() => {}}/>
    )
    // "--" appears in both rows for % left
    expect(getAllByText(/--/).length).toBeGreaterThanOrEqual(2)
    expect(container.querySelector('[data-testid="cc-quota-card"]')).toBeTruthy()
  })
})

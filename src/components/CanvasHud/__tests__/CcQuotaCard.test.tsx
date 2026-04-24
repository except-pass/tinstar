// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { CcQuotaCard } from '../CcQuotaCard'
import type { CcQuotaSnapshot } from '../../../hooks/useCcQuota'

function snap(partial: Partial<CcQuotaSnapshot['data']> = {}): CcQuotaSnapshot {
  return {
    fetchedAt: '2026-04-23T08:36:00.000Z',
    data: {
      five_hour: { utilization: 67, resets_at: '2026-04-23T11:49:00.000Z' },
      seven_day: { utilization: 89, resets_at: '2026-04-24T00:00:00.000Z' },
      ...partial,
    },
    error: null,
  }
}

describe('<CcQuotaCard>', () => {
  it('renders % left for each bucket — NOT % used', () => {
    const { getByText, queryByText } = render(
      <CcQuotaCard snapshot={snap()} nowMs={Date.parse('2026-04-23T08:36:00Z')}/>
    )
    expect(getByText('33% left')).toBeTruthy()
    expect(getByText('11% left')).toBeTruthy()
    expect(queryByText(/67% used/)).toBeNull()
    expect(queryByText(/89% used/)).toBeNull()
  })

  it('renders full skeleton with -- when snapshot has no data', () => {
    const empty: CcQuotaSnapshot = { fetchedAt: '2026-04-23T08:36:00.000Z', data: null, error: null }
    const { getAllByText, container } = render(<CcQuotaCard snapshot={empty}/>)
    expect(getAllByText(/--/).length).toBeGreaterThanOrEqual(2)
    expect(container.querySelector('[data-testid="cc-quota-card"]')).toBeTruthy()
  })

  it('has no refresh button (data flows in on every CC prompt)', () => {
    const { container, queryByLabelText } = render(
      <CcQuotaCard snapshot={snap()} nowMs={Date.parse('2026-04-23T08:36:00Z')}/>
    )
    expect(container.querySelector('.cc-quota-refresh')).toBeNull()
    expect(queryByLabelText('refresh quota')).toBeNull()
  })
})

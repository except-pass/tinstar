// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { CcQuotaClock } from '../CcQuotaClock'

const now = Date.parse('2026-04-23T08:36:00.000Z')

describe('<CcQuotaClock>', () => {
  it('renders -- when bucket is null', () => {
    const { container, getByText } = render(<CcQuotaClock bucket={null} nowMs={now} />)
    expect(getByText(/--/)).toBeTruthy()
    // no quota fill path drawn
    expect(container.querySelector('[data-testid="quota-fill"]')).toBeNull()
  })

  it('renders the 150° cycle trough + a quota fill arc when data is present', () => {
    const bucket = { utilization: 33, resets_at: '2026-04-23T11:49:00.000Z' }
    const { container } = render(<CcQuotaClock bucket={bucket} nowMs={now} />)
    expect(container.querySelector('[data-testid="cycle-trough"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="quota-fill"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="reset-marker"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="hour-hand"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="minute-hand"]')).toBeNull() // per spec, no minute hand
  })

  it('classifies deficit as "warn" when used ratio exceeds time in cycle by 0<d<=0.20', () => {
    // now = 08:36, reset at 11:49 → ~35.7% through cycle. used = 50% → deficit ≈ 0.143 → warn
    const bucket = { utilization: 50, resets_at: '2026-04-23T11:49:00.000Z' }
    const { container } = render(<CcQuotaClock bucket={bucket} nowMs={now} />)
    expect(container.querySelector('[data-testid="quota-fill"]')!.getAttribute('data-state')).toBe('warn')
  })

  it('classifies deficit as "bad" when used exceeds time by more than 0.20', () => {
    // time ~35.7%, used 80% → deficit ≈ 0.44 → bad
    const bucket = { utilization: 80, resets_at: '2026-04-23T11:49:00.000Z' }
    const { container } = render(<CcQuotaClock bucket={bucket} nowMs={now} />)
    expect(container.querySelector('[data-testid="quota-fill"]')!.getAttribute('data-state')).toBe('bad')
  })
})

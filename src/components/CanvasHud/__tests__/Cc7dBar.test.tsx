// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { Cc7dBar } from '../Cc7dBar'

const now = Date.parse('2026-04-23T08:36:00.000Z')

describe('<Cc7dBar>', () => {
  it('renders nothing quota-related when bucket is null (just --)', () => {
    const { container, getByText } = render(<Cc7dBar bucket={null} nowMs={now} />)
    expect(getByText(/--/)).toBeTruthy()
    expect(container.querySelector('[data-testid="bar-fill"]')).toBeNull()
  })

  it('renders trough, playhead, trailing-edge dot and reset marker when bucket is present', () => {
    const bucket = { utilization: 89, resets_at: '2026-04-24T00:00:00.000Z' }
    const { container } = render(<Cc7dBar bucket={bucket} nowMs={now} />)
    expect(container.querySelector('[data-testid="bar-trough"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="bar-fill"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="bar-playhead"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="bar-reset"]')).toBeTruthy()
  })

  it('shades a deficit rect when quota runner is ahead of time playhead', () => {
    // ~22h till reset on a 7d cycle → time_in_cycle ≈ 0.87. used 89% → small deficit ≈ 0.02 (warn)
    const bucket = { utilization: 89, resets_at: '2026-04-24T06:36:00.000Z' }
    const { container } = render(<Cc7dBar bucket={bucket} nowMs={now} />)
    const state = container.querySelector('[data-testid="bar-fill"]')!.getAttribute('data-state')
    expect(['warn', 'bad']).toContain(state)
    expect(container.querySelector('[data-testid="bar-deficit"]')).toBeTruthy()
  })
})

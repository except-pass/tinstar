import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { WaitingOnMain } from '../WaitingOnMain'

afterEach(cleanup)
it('shows a plain-comment fallback as an undelivered red Overview item', () => {
  const now = Date.parse('2026-11-11T12:00:00Z')
  render(<WaitingOnMain now={now} data={{ unknown: [], items: [{
    id: 'mate:key', source: 'mate:child', kind: 'mate', label: 'Child', key: 'key', text: 'Choose API',
    since: new Date(now - 4 * 3600_000).toISOString(), ageBasis: 'status timestamp', url: null,
    fresh: true, alert: 'plain-comment',
  }] }} />)
  fireEvent.click(screen.getByRole('button'))
  const status = screen.getByRole('status')
  expect(status.textContent).toContain('Owner alert not delivered (mention failed)')
  expect(status.textContent).toContain('next attempt after the 4h throttle')
  expect(status.closest('article')?.classList.contains('ov-main-wait-undelivered')).toBe(true)
})

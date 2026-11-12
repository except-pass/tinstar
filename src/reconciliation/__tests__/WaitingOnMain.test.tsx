import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { MAIN_WAIT_NUDGE_INTERVAL, type MainWaitItem, type MainWaitRead } from '../../shared/waitingOnMain'
import { WaitingOnMain } from '../WaitingOnMain'

afterEach(cleanup)
const now = Date.parse('2026-11-11T12:00:00Z')
const item = (nudgedAt?: string): MainWaitItem => ({
  id: 'mate:key', source: 'mate:child', kind: 'mate', label: 'Child', key: 'key', text: 'Choose API',
  since: new Date(now - 4 * 3600_000).toISOString(), ageBasis: 'status timestamp', url: null,
  fresh: true, alert: 'plain-comment', ...(nudgedAt ? { nudgedAt } : {}),
})
const data = (nudgedAt?: string, unknown: string[] = []): MainWaitRead => ({ unknown, items: [item(nudgedAt)] })

it('hides the waiting-on-main banner by default', () => {
  const { container, rerender } = render(<WaitingOnMain now={now} data={data()} />)
  expect(container).toBeEmptyDOMElement()
  rerender(<WaitingOnMain now={now} data={data(new Date(now - MAIN_WAIT_NUDGE_INTERVAL + 1).toISOString(), ['Hulk: parent asks unknown or stale'])} />)
  expect(screen.queryByRole('region', { name: 'Waiting on First Mate' })).toBeNull()
  expect(screen.queryByText(/coverage/)).toBeNull()
})

it('shows a quiet indicator after a nudge has been open for 2h, without the red banner', () => {
  render(<WaitingOnMain now={now} data={data(new Date(now - MAIN_WAIT_NUDGE_INTERVAL).toISOString(), ['Hulk: parent asks unknown or stale'])} />)
  const region = screen.getByRole('region', { name: 'Waiting on First Mate' })
  const button = screen.getByRole('button')
  expect(button.textContent).toBe('First Mate nudge still open')
  expect(region.classList.contains('ov-main-waits-overdue')).toBe(false)
  expect(region).toHaveAttribute('data-overdue', 'false')
  expect(button.textContent).not.toMatch(/coverage/)
  expect(screen.queryByText(/coverage/)).toBeNull()
  fireEvent.click(button)
  const status = screen.getByText(/Owner alert not delivered \(mention failed\)/)
  expect(status.closest('article')?.classList.contains('ov-main-wait-undelivered')).toBe(true)
  expect(region.classList.contains('ov-main-waits-overdue')).toBe(false)
})

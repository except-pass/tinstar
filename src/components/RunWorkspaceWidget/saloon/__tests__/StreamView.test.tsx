// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { StreamView } from '../StreamView'
import type { SaloonEvent } from '../useSaloonStream'

vi.mock('../useTopicMetadata', () => ({
  useTopicMetadata: (subject: string) =>
    subject === 'tinstar.a.b.c'
      ? { subject, name: 'Renamed Broadcast', kind: 'broadcast', createdAt: '' }
      : undefined,
}))

vi.mock('../../../../hooks/useBackendState', () => ({
  useBackendState: () => ({
    topicMetadata: [
      { subject: 'tinstar.a.b.c', name: 'Renamed Broadcast', kind: 'broadcast', createdAt: '' },
    ],
  }),
}))

const events: SaloonEvent[] = [
  { timestamp: '2026-04-24T12:00:00Z', subject: 'tinstar.a.b.c',          data: 'hello world', direction: 'inbound' },
  { timestamp: '2026-04-24T12:00:01Z', subject: 'tinstar.a.b.c.natsviz', data: 'dm payload',  direction: 'inbound' },
  { timestamp: '2026-04-24T12:00:02Z', subject: 'tinstar.breakout.x',     data: 'from hand', direction: 'inbound' },
]

describe('<StreamView>', () => {
  it('renders one row per event', () => {
    const { container } = render(
      <StreamView sessionName="natsViz" events={events} mutedSet={new Set()} onUnmuteAll={() => {}} />,
    )
    expect(container.querySelectorAll('[data-testid="saloon-msg"]')).toHaveLength(3)
  })

  it('filters rows by substring match against subject OR body', () => {
    const { container, getByPlaceholderText } = render(
      <StreamView sessionName="natsViz" events={events} mutedSet={new Set()} onUnmuteAll={() => {}} />,
    )
    fireEvent.change(getByPlaceholderText(/filter/i), { target: { value: 'dm' } })
    const rows = container.querySelectorAll('[data-testid="saloon-msg"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('dm payload')
  })

  it('hides events from muted subscriptions', () => {
    const { container } = render(
      <StreamView sessionName="natsViz" events={events} mutedSet={new Set(['tinstar.a.b.c'])} onUnmuteAll={() => {}} />,
    )
    expect(container.querySelectorAll('[data-testid="saloon-msg"]')).toHaveLength(2)
  })

  it('shows a "n hidden" pill when any subs are muted and fires onUnmuteAll on click', () => {
    const calls: number[] = []
    const { getByTestId } = render(
      <StreamView
        sessionName="natsViz"
        events={events}
        mutedSet={new Set(['tinstar.a.b.c', 'tinstar.breakout.x'])}
        onUnmuteAll={() => calls.push(1)}
      />,
    )
    const pill = getByTestId('saloon-hidden-pill')
    expect(pill.textContent).toMatch(/2 hidden/i)
    fireEvent.click(pill)
    expect(calls).toEqual([1])
  })

  it('renders metadata.name in the subject column when present', () => {
    const { container } = render(
      <StreamView sessionName="natsViz" events={events} mutedSet={new Set()} onUnmuteAll={() => {}} />,
    )
    expect(container.textContent).toContain('Renamed Broadcast')
  })

  it('filter matches against name as well as subject and body', () => {
    const { container, getByPlaceholderText } = render(
      <StreamView sessionName="natsViz" events={events} mutedSet={new Set()} onUnmuteAll={() => {}} />,
    )
    fireEvent.change(getByPlaceholderText(/filter/i), { target: { value: 'renamed' } })
    const rows = container.querySelectorAll('[data-testid="saloon-msg"]')
    // exactly the events whose subject is 'tinstar.a.b.c'
    expect(rows.length).toBe(events.filter(e => e.subject === 'tinstar.a.b.c').length)
  })
})

// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { SubscriptionsList } from '../SubscriptionsList'

vi.mock('../useTopicMetadata', () => ({
  useTopicMetadata: (subject: string) => {
    if (subject === 'tinstar.a.b.c') return { subject, name: 'Friendly Broadcast', kind: 'broadcast', createdAt: '' }
    if (subject === 'tinstar.room.r1') return { subject, name: 'Rubberduck Room', kind: 'breakout', createdAt: '' }
    return undefined
  },
}))

describe('<SubscriptionsList>', () => {
  const noop = () => {}

  it('renders one row per subscription with role-based classes', () => {
    const { container } = render(
      <SubscriptionsList
        sessionName="natsViz"
        subscriptions={[
          'tinstar.a.b.c',
          'tinstar.a.b.c.natsviz',
          'tinstar.room.room1',
        ]}
        mutedSet={new Set()}
        onToggleMute={noop}
      />,
    )
    expect(container.querySelectorAll('[data-testid="saloon-topic"]')).toHaveLength(3)
    expect(container.querySelector('[data-role="broadcast"]')).toBeTruthy()
    expect(container.querySelector('[data-role="dm"]')).toBeTruthy()
    expect(container.querySelector('[data-role="breakout"]')).toBeTruthy()
  })

  it('fires onToggleMute with the clicked subject', () => {
    const clicks: string[] = []
    const { container } = render(
      <SubscriptionsList
        sessionName="natsViz"
        subscriptions={['tinstar.x']}
        mutedSet={new Set()}
        onToggleMute={s => clicks.push(s)}
      />,
    )
    fireEvent.click(container.querySelector('[data-testid="saloon-topic"]')!)
    expect(clicks).toEqual(['tinstar.x'])
  })

  it('marks muted rows with data-muted', () => {
    const { container } = render(
      <SubscriptionsList
        sessionName="natsViz"
        subscriptions={['tinstar.x', 'tinstar.y']}
        mutedSet={new Set(['tinstar.y'])}
        onToggleMute={noop}
      />,
    )
    const rows = container.querySelectorAll('[data-testid="saloon-topic"]')
    expect(rows[0].getAttribute('data-muted')).toBe('false')
    expect(rows[1].getAttribute('data-muted')).toBe('true')
  })

  it('renders an empty-state when there are no subscriptions', () => {
    const { getByText } = render(
      <SubscriptionsList
        sessionName="natsViz"
        subscriptions={[]}
        mutedSet={new Set()}
        onToggleMute={noop}
      />,
    )
    expect(getByText(/no subscriptions/i)).toBeTruthy()
  })

  it('renders metadata.name when present, raw shortSubject otherwise', () => {
    const { container } = render(
      <SubscriptionsList
        sessionName="natsViz"
        subscriptions={['tinstar.a.b.c', 'tinstar.room.r1', 'tinstar.no.metadata']}
        mutedSet={new Set()}
        onToggleMute={() => {}}
      />,
    )
    expect(container.textContent).toContain('Friendly Broadcast')
    expect(container.textContent).toContain('Rubberduck Room')
    // Falls back to short-subject form for the unknown one
    expect(container.textContent).toMatch(/no\.metadata|…\.metadata/)
  })

  it('clicking the pencil icon switches to inline rename input', () => {
    const { container } = render(
      <SubscriptionsList
        sessionName="natsViz"
        subscriptions={['tinstar.a.b.c']}
        mutedSet={new Set()}
        onToggleMute={() => {}}
      />,
    )
    const editBtn = container.querySelector('[data-testid="saloon-rename"]')
    expect(editBtn).toBeTruthy()
    fireEvent.click(editBtn!)
    const input = container.querySelector('input[data-testid="saloon-rename-input"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.value).toBe('Friendly Broadcast')
  })
})

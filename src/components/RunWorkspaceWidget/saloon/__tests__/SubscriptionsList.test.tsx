// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { SubscriptionsList } from '../SubscriptionsList'

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
})

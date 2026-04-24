// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { SaloonPanel } from '../SaloonPanel'

describe('<SaloonPanel>', () => {
  const baseProps = {
    sessionName: 'natsViz',
    subscriptions: ['tinstar.a.b.c', 'tinstar.a.b.c.natsviz'],
  }

  it('renders SALOON header with subscription count', () => {
    const { container } = render(
      <SaloonPanel {...baseProps} natsEnabled={true} natsControlOrphanedAt={null} />,
    )
    expect(container.textContent).toMatch(/SALOON/i)
    expect(container.textContent).toMatch(/2 subs/i)
  })

  it('shows green broker dot when enabled and not orphaned', () => {
    const { container } = render(
      <SaloonPanel {...baseProps} natsEnabled={true} natsControlOrphanedAt={null} />,
    )
    expect(container.querySelector('[data-testid="saloon-dot"][data-status="ok"]')).toBeTruthy()
  })

  it('shows red broker dot when orphaned', () => {
    const { container } = render(
      <SaloonPanel {...baseProps} natsEnabled={true} natsControlOrphanedAt="2026-04-24T00:00:00Z" />,
    )
    expect(container.querySelector('[data-testid="saloon-dot"][data-status="bad"]')).toBeTruthy()
  })

  it('shows red broker dot when NATS disabled', () => {
    const { container } = render(
      <SaloonPanel {...baseProps} natsEnabled={false} natsControlOrphanedAt={null} />,
    )
    expect(container.querySelector('[data-testid="saloon-dot"][data-status="bad"]')).toBeTruthy()
  })

  it('toggles mute state on topic click', () => {
    const { container } = render(
      <SaloonPanel {...baseProps} natsEnabled={true} natsControlOrphanedAt={null} />,
    )
    const [firstTopic] = container.querySelectorAll('[data-testid="saloon-topic"]')
    expect(firstTopic.getAttribute('data-muted')).toBe('false')
    fireEvent.click(firstTopic)
    const [firstTopicAfter] = container.querySelectorAll('[data-testid="saloon-topic"]')
    expect(firstTopicAfter.getAttribute('data-muted')).toBe('true')
  })
})

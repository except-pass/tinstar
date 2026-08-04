// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { RunSessionPanel } from '../RunSessionPanel'
import type { RecapEntry } from '../../../types'

const ACCENT = '#ff7700'

const entries: RecapEntry[] = [
  { id: 'a1', type: 'agent', content: 'hello from agent' },
  { id: 'u1', type: 'user', content: 'hello from user' },
  { id: 's1', type: 'status', content: 'idle' },
]

describe('<RunSessionPanel> recap visuals', () => {
  it('renders the recap pane on a black background', () => {
    const { container } = render(
      <RunSessionPanel
        recapEntries={entries}
        rawLogs=""
        port={undefined}
        sessionId="run-1"
        status="idle"
        color={ACCENT}
        controlledTab="recap"
        onControlledTabChange={() => {}}
      />,
    )
    const pane = container.querySelector('[data-testid="recap-pane"]')
    expect(pane).toBeTruthy()
    expect(pane?.className).toMatch(/bg-black/)
  })

  it('paints AGENT label with the session accent (not theme primary)', () => {
    const { container } = render(
      <RunSessionPanel
        recapEntries={entries}
        rawLogs=""
        port={undefined}
        sessionId="run-1"
        status="idle"
        color={ACCENT}
        controlledTab="recap"
        onControlledTabChange={() => {}}
      />,
    )
    const label = container.querySelector('[data-testid="recap-agent-label"]')
    expect(label).toBeTruthy()
    expect((label as HTMLElement).style.color).toBe('rgb(255, 119, 0)')
  })
})

describe('<RunSessionPanel> composer placement', () => {
  it('renders the prompt composer on the Recap tab', () => {
    const { container } = render(
      <RunSessionPanel
        recapEntries={entries}
        rawLogs=""
        port={undefined}
        sessionId="run-1"
        status="idle"
        color={ACCENT}
        controlledTab="recap"
        onControlledTabChange={() => {}}
      />,
    )
    expect(container.querySelector('[data-testid="prompt-composer"]')).toBeTruthy()
  })

  it('does not render the composer when sessionId is missing', () => {
    const { container } = render(
      <RunSessionPanel
        recapEntries={entries}
        rawLogs=""
        port={undefined}
        sessionId={undefined}
        status="idle"
        color={ACCENT}
        controlledTab="recap"
        onControlledTabChange={() => {}}
      />,
    )
    expect(container.querySelector('[data-testid="prompt-composer"]')).toBeFalsy()
  })
})

describe('<RunSessionPanel> terminal wrapper bridge', () => {
  it('forwards only messages from the owned, same-origin terminal wrapper', () => {
    const cycles: string[] = []
    const boundaries: string[] = []
    window.addEventListener('tinstar:terminal-session-cycle', (event) => {
      cycles.push((event as CustomEvent<{ action: string }>).detail.action)
    }, { once: true })
    window.addEventListener('tinstar:terminal-scroll-boundary', (event) => {
      boundaries.push((event as CustomEvent<{ direction: string }>).detail.direction)
    }, { once: true })
    const { container, unmount } = render(
      <RunSessionPanel sessionId="run-1" status="idle" port={19999} controlledTab="terminal" />,
    )
    const frame = container.querySelector('iframe') as HTMLIFrameElement
    const source = frame.contentWindow!
    const origin = new URL(frame.src).origin

    fireEvent(window, new MessageEvent('message', { source: window, origin, data: { type: 'terminal-session-cycle', sessionName: 'run-1', action: 'ready-next' } }))
    fireEvent(window, new MessageEvent('message', { source, origin: 'https://forged.invalid', data: { type: 'terminal-session-cycle', sessionName: 'run-1', action: 'ready-next' } }))
    fireEvent(window, new MessageEvent('message', { source, origin, data: { type: 'terminal-session-cycle', sessionName: 'other', action: 'ready-next' } }))
    fireEvent(window, new MessageEvent('message', { source, origin, data: { type: 'terminal-session-cycle', sessionName: 'run-1', action: 'bogus' } }))
    fireEvent(window, new MessageEvent('message', { source, origin, data: { type: 'terminal-session-cycle', sessionName: 'run-1', action: 'all-prev' } }))
    fireEvent(window, new MessageEvent('message', { source, origin, data: { type: 'terminal-scroll-boundary', sessionName: 'run-1', direction: 'next' } }))

    expect(cycles).toEqual(['all-prev'])
    expect(boundaries).toEqual(['next'])
    unmount()
  })
})

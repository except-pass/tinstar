// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
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

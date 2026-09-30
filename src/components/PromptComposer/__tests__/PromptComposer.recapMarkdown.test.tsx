// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { PromptComposer } from '../PromptComposer'
import type { RecapEntry } from '../../../types'

vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })),
  apiUrl: (path: string) => path,
}))

vi.mock('../../../hooks/useSlashCommands', () => ({
  useSlashCommands: () => ({ commands: [], usage: {}, refresh: () => {} }),
}))

const ACCENT = '#ff7700'

function renderComposer(recapEntries: RecapEntry[], status: 'creating' | 'running' | 'idle' | 'needs_attention' | 'stopped' = 'idle') {
  return render(
    <PromptComposer
      recapEntries={recapEntries}
      rawLogs=""
      port={undefined}
      sessionId="run-1"
      status={status}
      accent={ACCENT}
      promptComposerExpanded={true}
      controlledTab="recap"
      onControlledTabChange={() => {}}
    />,
  )
}

describe('<PromptComposer> recap markdown rendering', () => {
  it('shows a live working divider only while the session is running', () => {
    const running = renderComposer([], 'running')
    expect(running.getByTestId('recap-working-status')).toHaveTextContent('Working')
    running.unmount()

    for (const status of ['creating', 'idle', 'needs_attention', 'stopped'] as const) {
      const view = renderComposer([], status)
      expect(view.queryByTestId('recap-working-status')).toBeNull()
      view.unmount()
    }
  })

  it('renders completed history with compact duration and no pulse', () => {
    const { getByTestId } = renderComposer([
      { id: 'u-complete', type: 'user', content: 'do it' },
      { id: 's-complete', type: 'status', statusKind: 'completed', content: 'Completed', durationMs: 72_000 },
      { id: 'a-complete', type: 'agent', content: 'done' },
    ])
    const completed = getByTestId('recap-completed-status')
    expect(completed).toHaveTextContent('Completed in 1m 12s')
    expect(completed.querySelector('.animate-pulse-glow')).toBeNull()
  })

  it('renders completed history without inventing a duration', () => {
    const { getByTestId } = renderComposer([
      { id: 's-complete', type: 'status', statusKind: 'completed', content: 'Completed' },
    ])
    expect(getByTestId('recap-completed-status')).toHaveTextContent('Completed')
    expect(getByTestId('recap-completed-status')).not.toHaveTextContent('Completed in')
  })

  it('renders agent markdown emphasis, lists, and inline code as HTML elements', () => {
    const { container } = renderComposer([
      {
        id: 'a1',
        type: 'agent',
        content: 'Here is **bold** text and `inline code`.\n\n- first item\n- second item',
      },
    ])
    const pane = container.querySelector('[data-testid="recap-pane"]')!
    expect(pane.querySelector('strong')).toBeTruthy()
    expect(pane.querySelector('code')).toBeTruthy()
    expect(pane.querySelectorAll('li')).toHaveLength(2)
  })

  it('renders markdown headings and links in user messages', () => {
    const { container } = renderComposer([
      {
        id: 'u1',
        type: 'user',
        content: '# Title\n\nSee [the docs](https://example.com).',
      },
    ])
    const pane = container.querySelector('[data-testid="recap-pane"]')!
    expect(pane.querySelector('h1')?.textContent).toBe('Title')
    const link = pane.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com')
  })

  it('renders fenced code blocks as a pre element', () => {
    const { container } = renderComposer([
      {
        id: 'a2',
        type: 'agent',
        content: '```ts\nconst x = 1\n```',
      },
    ])
    const pane = container.querySelector('[data-testid="recap-pane"]')!
    expect(pane.querySelector('pre')).toBeTruthy()
    expect(pane.textContent).toContain('const x = 1')
  })

  it('preserves single newlines in plain text as hard line breaks (remark-breaks)', () => {
    const { container } = renderComposer([
      {
        id: 'u2',
        type: 'user',
        content: 'line one\nline two',
      },
    ])
    const pane = container.querySelector('[data-testid="recap-pane"]')!
    expect(pane.querySelector('br')).toBeTruthy()
    expect(pane.textContent).toContain('line one')
    expect(pane.textContent).toContain('line two')
  })

  it('renders an UNLABELED multi-line fenced block as a pre (not collapsed inline)', () => {
    const { container } = renderComposer([
      {
        id: 'a3',
        type: 'agent',
        content: '```\nline one\nline two\n```',
      },
    ])
    const pane = container.querySelector('[data-testid="recap-pane"]')!
    expect(pane.querySelector('pre')).toBeTruthy()
    expect(pane.textContent).toContain('line one')
    expect(pane.textContent).toContain('line two')
  })
})

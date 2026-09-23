// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { WidgetProps } from '@tinstar/plugin-api'
import { FirstmateCard, safePrUrl } from './FirstmateCard'

const props = (firstmate: unknown): WidgetProps => ({
  data: { firstmate, sessionId: 'fm--t' }, zoom: 1, isSelected: false, isDragging: false, isHovered: false, isDropTarget: false,
})

const base = {
  task: 'fix-login', kind: 'ship', project: 'webapp', harness: 'claude', model: 'opus',
  status: 'working', statusText: 'reproducing the bug', statusTs: 1, decisions: [], pr: null, merged: null, worktree: null,
}

describe('FirstmateCard', () => {
  it('shows task, kind, project, harness, model and the latest status line', () => {
    render(<FirstmateCard {...props(base)} />)
    expect(screen.getByText('fix-login')).toBeTruthy()
    for (const v of ['ship', 'webapp', 'claude', 'opus']) expect(screen.getByText(v)).toBeTruthy()
    expect(screen.getByTestId('firstmate-status').textContent).toBe('reproducing the bug')
    expect(screen.queryByTestId('firstmate-decisions')).toBeNull()
    expect(screen.queryByTestId('firstmate-pr')).toBeNull()
  })

  it('lists open decisions and the PR link with merge state', () => {
    render(<FirstmateCard {...props({
      ...base, status: 'needs-decision',
      decisions: [{ key: 'k1', state: 'needs-decision', text: 'A or B?', ts: 1 }],
      pr: 'https://github.com/acme/webapp/pull/7', merged: { via: 'pr', pr: 'https://github.com/acme/webapp/pull/7' },
    })} />)
    expect(screen.getByTestId('firstmate-decisions').textContent).toContain('A or B?')
    const link = screen.getByRole('link') as HTMLAnchorElement
    expect(link.href).toBe('https://github.com/acme/webapp/pull/7')
    expect(link.rel).toContain('noopener')
    expect(screen.getByTestId('firstmate-pr').textContent).toContain('merged')
  })

  it('renders untrusted status text as plain text, never as markup', () => {
    render(<FirstmateCard {...props({ ...base, statusText: '<img src=x onerror=alert(1)><b>hi</b>' })} />)
    const el = screen.getByTestId('firstmate-status')
    expect(el.querySelector('img')).toBeNull()
    expect(el.querySelector('b')).toBeNull()
    expect(el.textContent).toBe('<img src=x onerror=alert(1)><b>hi</b>')
  })

  it('only makes https PR urls clickable', () => {
    expect(safePrUrl('https://github.com/a/b/pull/1')).toBe('https://github.com/a/b/pull/1')
    expect(safePrUrl('javascript:alert(1)')).toBeNull()
    expect(safePrUrl('http://x/y')).toBeNull()
    expect(safePrUrl('not a url')).toBeNull()
    render(<FirstmateCard {...props({ ...base, pr: 'javascript:alert(1)' })} />)
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('says why there is no live terminal, and stays quiet when there is one', () => {
    render(<FirstmateCard {...props({ ...base, terminal: { state: 'unavailable', reason: 'no window recorded yet' } })} />)
    expect(screen.getByTestId('firstmate-terminal-note').textContent).toContain('no window recorded yet')
    cleanup()
    render(<FirstmateCard {...props({ ...base, terminal: { state: 'live', reason: null } })} />)
    expect(screen.queryByTestId('firstmate-terminal-note')).toBeNull()
  })

  it('degrades when the run carries no firstmate data', () => {
    render(<FirstmateCard {...props(undefined)} />)
    expect(screen.getByTestId('firstmate-card-empty')).toBeTruthy()
  })

  it('shows the running/idle light and the linked conversation id', () => {
    render(<FirstmateCard {...props({ ...base, runId: 'fm--fix-login', conversationId: 'abc12345-conv', conversationSource: 'auto', activity: 'running' })} />)
    expect(screen.getByTestId('firstmate-activity').getAttribute('data-activity')).toBe('running')
    expect(screen.getByTestId('firstmate-conversation').textContent).toContain('abc12345-conv')
  })

  it('shows a neutral light when no conversation is linked', () => {
    render(<FirstmateCard {...props(base)} />)
    expect(screen.getByTestId('firstmate-activity').getAttribute('data-activity')).toBe('none')
  })

  it('submits a manual conversation override', async () => {
    const calls: Array<[string, string | null]> = []
    const set = async (id: string, conv: string | null) => { calls.push([id, conv]); return true }
    render(<FirstmateCard {...props({ ...base, runId: 'fm--fix-login', conversationId: null, conversationSource: null, activity: null })} setConversation={set} />)
    fireEvent.click(screen.getByText('override'))
    fireEvent.change(screen.getByLabelText('conversation id'), { target: { value: ' conv-1234567 ' } })
    fireEvent.click(screen.getByText('set'))
    await waitFor(() => expect(calls).toEqual([['fm--fix-login', 'conv-1234567']]))
  })
})

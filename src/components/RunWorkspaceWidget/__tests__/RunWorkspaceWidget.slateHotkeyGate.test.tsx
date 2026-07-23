// @vitest-environment jsdom
//
// S6 U1 — the focus-zone gate on the Slate's six registry keys.
//
// This is the one piece of wiring that decides whether j/k/x/r/c// are SAFE: the
// bindings are registered on the whole run-workspace widget, so without the gate they
// would act on the Slate from the file list or the session pane. And declining has to
// be visible to the router — a gated key must fall through untouched (no
// preventDefault, no sidebar confirmation flash), not be silently swallowed.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { forwardRef, useImperativeHandle } from 'react'
import { render, cleanup, act } from '@testing-library/react'
import type { RunData } from '../../../domain/types'
import { dispatchAction } from '../../../hotkeys/actionHandlerRegistry'

const handle = {
  focusNext: vi.fn(),
  focusPrev: vi.fn(),
  hideFocused: vi.fn(),
  refreshFocused: vi.fn(),
  openComposer: vi.fn(),
  focusSearch: vi.fn(),
  toggleCheatsheet: vi.fn(),
}

vi.mock('../RunWorkspaceHeader', () => ({ RunWorkspaceHeader: () => null }))
vi.mock('../TouchedFilesPanel', () => ({ TouchedFilesPanel: () => null }))
vi.mock('../FileTreePanel', () => ({ FileTreePanel: () => null }))
vi.mock('../RunSessionPanel', () => ({ RunSessionPanel: () => null }))
vi.mock('../TelemetryPanel', () => ({ TelemetryPanel: () => null }))
vi.mock('../HandsPanel', () => ({ HandsPanel: () => null }))
vi.mock('../SlatePanel', async () => {
  const react = await import('react')
  return {
    SlatePanel: forwardRef<typeof handle>(function MockSlatePanel(_props, ref) {
      useImperativeHandle(ref, () => handle, [])
      return react.createElement('div', { 'data-testid': 'slate-panel-mock' })
    }),
  }
})

import { RunWorkspaceWidget } from '../index'

function makeRun(): RunData {
  return {
    id: 'r1',
    color: '#ff7700',
    status: 'idle',
    background: false,
    blocked: false,
    sessionId: 'sess-1',
    taskId: 't1',
    initiative: 'init',
    epic: 'epic',
    task: 'task',
    repo: 'repo',
    worktree: 'wt',
    touchedFiles: [],
    recapEntries: [],
    rawLogs: '',
    port: null,
    backend: null,
    slate: [{
      id: 's1',
      author: 'agent',
      kind: 'diagram',
      body: { root: 'root', components: [{ id: 'root', component: 'Text', text: 'x' }] },
      createdAt: 1,
      amendedAt: 1,
    }],
  }
}

const SLATE_ACTIONS = [
  'slate-focus-next', 'slate-focus-prev', 'slate-hide-focused',
  'slate-refresh-focused', 'slate-compose', 'slate-search',
] as const

describe('RunWorkspaceWidget — the Slate focus-zone gate (S6 U1)', () => {
  beforeEach(() => {
    localStorage.clear()
    cleanup()
    for (const fn of Object.values(handle)) fn.mockReset()
  })

  it('DECLINES every Slate key while another zone holds focus', () => {
    render(<RunWorkspaceWidget run={makeRun()} headless />)
    // Nothing focused yet — the run card was never tabbed into.
    for (const action of SLATE_ACTIONS) {
      let handled: boolean | undefined
      act(() => { handled = dispatchAction('r1', action) })
      // `false` is what tells the router to leave the keystroke alone: no
      // preventDefault, and no confirmation flash for something that did nothing.
      expect(handled, action).toBe(false)
    }
    for (const fn of Object.values(handle)) expect(fn).not.toHaveBeenCalled()
  })

  it('claims them once the Slate zone holds focus', () => {
    render(<RunWorkspaceWidget run={makeRun()} headless />)

    // Tab forward until the Slate zone is reached (its position depends on which
    // panels are expanded, so walk rather than hard-code an index).
    let handled = false
    for (let i = 0; i < 8 && !handled; i++) {
      act(() => { dispatchAction('r1', 'focus-next') })
      act(() => { handled = dispatchAction('r1', 'slate-focus-next') })
    }

    expect(handled).toBe(true)
    expect(handle.focusNext).toHaveBeenCalled()

    act(() => { dispatchAction('r1', 'slate-hide-focused') })
    expect(handle.hideFocused).toHaveBeenCalled()
  })
})

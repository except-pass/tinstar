// @vitest-environment jsdom
//
// Slate v2 U1/R1 — the Slate column drag-resizes and the settled width persists
// per-browser (uiPrefs `slateWidth`), restored on the next mount. The child
// panels are mocked to null so this test exercises ONLY the index.tsx layout +
// the slate resize handler (clamp + left-drag-widens + persist-on-up).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, fireEvent, cleanup } from '@testing-library/react'
import type { RunData } from '../../../domain/types'
import type { SlateSurface } from '../../../types'
import { getPref, setPref } from '../../../lib/uiPrefs'

// Mock every heavy child panel to null — the resize handle lives in index.tsx.
vi.mock('../RunWorkspaceHeader', () => ({ RunWorkspaceHeader: () => null }))
vi.mock('../TouchedFilesPanel', () => ({ TouchedFilesPanel: () => null }))
vi.mock('../FileTreePanel', () => ({ FileTreePanel: () => null }))
vi.mock('../RunSessionPanel', () => ({ RunSessionPanel: () => null }))
vi.mock('../TelemetryPanel', () => ({ TelemetryPanel: () => null }))
vi.mock('../HandsPanel', () => ({ HandsPanel: () => null }))
vi.mock('../SlatePanel', () => ({ SlatePanel: () => null }))

import { RunWorkspaceWidget } from '../index'

const slateSurface: SlateSurface = {
  id: 's1',
  author: 'agent',
  kind: 'diagram',
  body: { root: 'root', components: [{ id: 'root', component: 'Text', text: 'x' }] },
  createdAt: 1,
  amendedAt: 1,
}

function makeRun(overrides: Partial<RunData> = {}): RunData {
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
    slate: [slateSurface],
    ...overrides,
  }
}

describe('RunWorkspaceWidget — Slate column resize (U1/R1)', () => {
  beforeEach(() => {
    localStorage.clear()
    // jsdom does not implement pointer capture; the handler calls it.
    ;(Element.prototype as unknown as { setPointerCapture: () => void }).setPointerCapture = () => {}
    cleanup()
  })

  it('restores the persisted width on mount', () => {
    setPref('slateWidth', 500)
    const { getByTestId } = render(<RunWorkspaceWidget run={makeRun()} headless />)
    const col = getByTestId('slate-resize-handle').parentElement as HTMLElement
    expect(col.style.width).toBe('500px')
  })

  it('dragging the handle left widens the column and persists on release', () => {
    setPref('slateWidth', 320)
    const { getByTestId } = render(<RunWorkspaceWidget run={makeRun()} headless />)
    const handle = getByTestId('slate-resize-handle')
    const col = handle.parentElement as HTMLElement

    // Drag left by 100px → width grows 320 → 420 (left border grab widens).
    fireEvent.pointerDown(handle, { clientX: 1000, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 900, pointerId: 1 })
    expect(col.style.width).toBe('420px')

    // Not persisted until pointer up.
    expect(getPref('slateWidth')).toBe(320)
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(getPref('slateWidth')).toBe(420)
  })

  it('clamps the width to the max (560) when dragged far left', () => {
    setPref('slateWidth', 320)
    const { getByTestId } = render(<RunWorkspaceWidget run={makeRun()} headless />)
    const handle = getByTestId('slate-resize-handle')
    const col = handle.parentElement as HTMLElement

    fireEvent.pointerDown(handle, { clientX: 1000, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 }) // +1000 → clamp
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(col.style.width).toBe('560px')
    expect(getPref('slateWidth')).toBe(560)
  })

  it('clamps the width to the min (260) when dragged far right', () => {
    setPref('slateWidth', 320)
    const { getByTestId } = render(<RunWorkspaceWidget run={makeRun()} headless />)
    const handle = getByTestId('slate-resize-handle')
    const col = handle.parentElement as HTMLElement

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 1000, pointerId: 1 }) // -900 → clamp
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(col.style.width).toBe('260px')
    expect(getPref('slateWidth')).toBe(260)
  })
})

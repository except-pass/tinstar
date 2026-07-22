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

  it('clamps the width to the max (900) when dragged far left', () => {
    setPref('slateWidth', 320)
    const { getByTestId } = render(<RunWorkspaceWidget run={makeRun()} headless />)
    const handle = getByTestId('slate-resize-handle')
    const col = handle.parentElement as HTMLElement

    fireEvent.pointerDown(handle, { clientX: 2000, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientX: 0, pointerId: 1 }) // +2000 → clamp
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(col.style.width).toBe('900px')
    expect(getPref('slateWidth')).toBe(900)
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

describe('RunWorkspaceWidget — telemetry collapse + open-blank-Slate', () => {
  beforeEach(() => {
    localStorage.clear()
    if (!('setPointerCapture' in HTMLElement.prototype)) {
      // @ts-expect-error jsdom shim
      HTMLElement.prototype.setPointerCapture = () => {}
      // @ts-expect-error jsdom shim
      HTMLElement.prototype.releasePointerCapture = () => {}
    }
  })

  it('telemetry hide → collapses to a strip and persists; the strip restores it', () => {
    const { getByTestId, queryByTestId } = render(<RunWorkspaceWidget run={makeRun()} headless />)
    // Shown by default: the hide button is present, no collapsed strip.
    expect(queryByTestId('collapsed-telemetry')).toBeNull()
    fireEvent.click(getByTestId('telemetry-hide'))
    // Collapsed: the strip replaces the panel and the pref sticks.
    expect(getByTestId('collapsed-telemetry')).toBeTruthy()
    expect(getPref('telemetryCollapsed')).toBe(true)
    // Clicking the strip brings telemetry back.
    fireEvent.click(getByTestId('collapsed-telemetry'))
    expect(queryByTestId('collapsed-telemetry')).toBeNull()
    expect(getPref('telemetryCollapsed')).toBe(false)
  })

  it('an empty run shows the open-Slate strip; clicking it opens the column and persists', () => {
    const { getByTestId, queryByTestId } = render(<RunWorkspaceWidget run={makeRun({ slate: [] })} headless />)
    // No surfaces + not opened → the thin open-Slate strip, no column.
    expect(getByTestId('slate-open-strip')).toBeTruthy()
    expect(queryByTestId('focus-zone-slate')).toBeNull()
    fireEvent.click(getByTestId('slate-open-strip'))
    // Opened → the full column renders even though the run has zero surfaces.
    expect(getByTestId('focus-zone-slate')).toBeTruthy()
    expect(queryByTestId('slate-open-strip')).toBeNull()
    expect(getPref('slateOpen')).toBe(true)
  })

  it('a run WITH surfaces shows the column, never the open-Slate strip', () => {
    const { getByTestId, queryByTestId } = render(<RunWorkspaceWidget run={makeRun()} headless />)
    expect(getByTestId('focus-zone-slate')).toBeTruthy()
    expect(queryByTestId('slate-open-strip')).toBeNull()
  })
})

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunData } from '../../../domain/types'
import { FocusPresentationProvider } from '../../../focusMode/FocusPresentationContext'
import { getPref, setPref } from '../../../lib/uiPrefs'

afterEach(cleanup)

vi.mock('../RunWorkspaceHeader', () => ({ RunWorkspaceHeader: () => <div data-testid="header" /> }))
vi.mock('../TouchedFilesPanel', () => ({ TouchedFilesPanel: () => <div data-testid="files-content" /> }))
vi.mock('../FileTreePanel', () => ({ FileTreePanel: () => <div data-testid="tree-content" /> }))
vi.mock('../RunSessionPanel', () => ({ RunSessionPanel: () => <div data-testid="session-content" /> }))
vi.mock('../TelemetryPanel', () => ({ TelemetryPanel: () => <div data-testid="telemetry-content" /> }))
vi.mock('../HandsPanel', () => ({ HandsPanel: () => null }))
vi.mock('../SlatePanel', async () => {
  const { forwardRef } = await import('react')
  return { SlatePanel: forwardRef(function MockSlatePanel() { return <div data-testid="slate-content" /> }) }
})

import { RunWorkspaceWidget } from '../index'

function makeRun(overrides: Partial<RunData> = {}): RunData {
  return {
    id: 'r1', sessionId: 's1', status: 'idle', color: '#00f0ff',
    background: false, blocked: false, taskId: 't1', initiative: 'i', epic: 'e', task: 't',
    repo: 'repo', worktree: 'wt', touchedFiles: [], recapEntries: [], rawLogs: '', port: null,
    backend: null,
    slate: [{
      id: 'slate-1', author: 'agent', kind: 'diagram',
      body: { root: 'root', components: [{ id: 'root', component: 'Text', text: 'x' }] },
      createdAt: 1, amendedAt: 1,
    }],
    ...overrides,
  }
}

function renderFocused(width: number, run = makeRun()) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width, height: 700, top: 0, left: 0, right: width, bottom: 700, x: 0, y: 0, toJSON: () => ({}),
  })
  return render(
    <FocusPresentationProvider value="focus">
      <RunWorkspaceWidget run={run} />
    </FocusPresentationProvider>,
  )
}

describe('RunWorkspaceWidget focus layout', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    })
  })

  it('keeps the full composition when its content demand fits', () => {
    renderFocused(1400)
    expect(screen.queryByTestId('focus-files-rail')).not.toBeInTheDocument()
    expect(screen.queryByTestId('focus-telemetry-rail')).not.toBeInTheDocument()
    expect(screen.getByTestId('files-content')).toBeVisible()
    expect(screen.getByTestId('telemetry-content')).toBeVisible()
  })

  it('uses mutually exclusive support drawers and Escape returns focus to the rail', () => {
    renderFocused(1100)
    const filesRail = screen.getByTestId('focus-files-rail')
    const telemetryRail = screen.getByTestId('focus-telemetry-rail')

    fireEvent.click(filesRail)
    expect(screen.getByTestId('focus-files-drawer')).toBeVisible()
    expect(screen.queryByTestId('focus-telemetry-drawer')).not.toBeInTheDocument()

    fireEvent.click(telemetryRail)
    expect(screen.queryByTestId('focus-files-drawer')).not.toBeInTheDocument()
    expect(screen.getByTestId('focus-telemetry-drawer')).toBeVisible()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('focus-telemetry-drawer')).not.toBeInTheDocument()
    expect(telemetryRail).toHaveFocus()
  })

  it('does not overwrite normal panel preferences while adapting', () => {
    setPref('slateWidth', 500)
    setPref('telemetryCollapsed', false)
    renderFocused(1000)

    fireEvent.click(screen.getByTestId('focus-telemetry-rail'))
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(getPref('slateWidth')).toBe(500)
    expect(getPref('telemetryCollapsed')).toBe(false)
  })

  it('keeps the existing Slate opener when there is no Slate content', () => {
    renderFocused(800, makeRun({ slate: [] }))
    expect(screen.getByTestId('slate-open-strip')).toBeVisible()
    expect(screen.getByTestId('focus-files-rail')).toBeVisible()
    expect(screen.getByTestId('focus-telemetry-rail')).toBeVisible()
  })
})

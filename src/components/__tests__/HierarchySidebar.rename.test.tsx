// @vitest-environment jsdom
//
// U3 (R7/R9/R11/R12): renaming a run from the hierarchy sidebar.
//
// These wire the REAL dispatcher (WorkspaceShell.dispatchRename) into the REAL
// sidebar, because the bug being guarded against lives in the seam between
// them: `commitRename` used to bail out on `node.type === 'run'`, so a run's
// inline edit committed nothing and no PATCH was ever sent. Asserting only that
// the sidebar calls `onRename` would have passed against the old code path
// change while still routing runs at the wrong endpoint.
//
// Only the transport (apiFetch) and the state store are stand-ins.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import type { GroupingDimension, Run, TreeNode } from '../../domain/types'
import { buildGroupTree } from '../../domain/grouping'
import { TaxonomyRepository } from '../../domain/repositories'

const apiFetch = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>()
vi.mock('../../apiClient', () => ({
  apiFetch: (url: string, init?: RequestInit) => apiFetch(url, init),
  apiUrl: (p: string) => p,
}))

// WorkspaceShell's module graph reaches the plugin host, whose top-level IIFE
// boots every bundled plugin on import. Stub it — this test is about renaming.
vi.mock('../../widgets', () => ({
  pluginsReady: Promise.resolve(),
  pluginRegistry: { widgetTypes: () => [], get: () => undefined },
}))

// Partial: WorkspaceShell's own import graph (useHiddenRuns) needs the real
// familyKeys/readJSON, so only the sidebar's prefs reads are stubbed.
vi.mock('../../lib/uiPrefs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/uiPrefs')>()),
  getPref: vi.fn(() => undefined),
  setPref: vi.fn(),
  getSidebarView: vi.fn(() => 'hierarchy'),
  setSidebarView: vi.fn(),
}))

vi.mock('../../hooks/useInbox', () => ({
  useInbox: () => ({ rows: [], unreadCount: 0 }),
}))

vi.mock('../InboxList', () => ({ InboxList: () => null }))

vi.mock('../SelectionProvider', () => ({
  useSelection: () => ({
    isSelected: () => false,
    isExpanded: () => true,
    isHovered: () => false,
    select: vi.fn(),
    toggleSelect: vi.fn(),
    hover: vi.fn(),
    toggleExpand: vi.fn(),
    expandAll: vi.fn(),
  }),
}))

vi.mock('../../hooks/useSidebarDrag', () => ({
  useSidebarDrag: () => ({
    dragState: null,
    dropTarget: null,
    scrollContainerRef: { current: null },
    dragInitiated: { current: false },
    handleDragStart: vi.fn(),
    handleDragMove: vi.fn(),
    handleDragEnd: vi.fn(),
  }),
}))

vi.mock('../../hooks/useDimensionMeta', () => ({ useDimensionMeta: () => [] }))

vi.mock('../../hotkeys/ConstellationContext', () => ({
  useConstellationContext: () => ({ slotsForNode: () => [], remove: vi.fn() }),
}))

vi.mock('../../hotkeys/FocusPathContext', () => ({
  useHotkeyContext: () => ({ path: [], chordState: null, activeDefinition: null }),
}))

vi.mock('../../hotkeys/bindingFiredBus', () => ({ onBindingFired: () => () => {} }))

vi.mock('../HotkeyBindingRow', () => ({
  BindingRow: () => null,
  GLOBAL_KEYS: [],
  CANVAS_KEYS: [],
  QUICKDRAW_KEYS: [],
}))

vi.mock('../SpaceSwitcher', () => ({ SpaceSwitcher: () => null }))

vi.mock('../../hooks/usePluginWidgetRegistry', () => ({
  usePluginWidgetRegistry: () => ({ entries: [], error: null, iconByType: new Map() }),
}))

vi.mock('../agentIcon', () => ({ AgentIcon: () => null, isIconUrl: () => false }))

// Imported after the mocks so the stubbed modules are the ones it binds to.
const { default: HierarchySidebar } = await import('../HierarchySidebar')
const { dispatchRename } = await import('../WorkspaceShell')

const RUN_ID = 'vpppm-general-pourpose-2dc86'

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    status: 'running',
    background: false,
    blocked: false,
    sessionId: RUN_ID,
    taskId: 'tsk-1',
    worktreeId: 'wt-1',
    createdAt: '2026-07-13T00:00:00.000Z',
    color: '#22d3ee',
    initiative: '', epic: '', task: '', repo: '', worktree: '',
    touchedFiles: [], recapEntries: [], rawLogs: '',
    port: null, backend: 'tmux',
    ...over,
  } as Run
}

function taxonomyNode(id: string, type: GroupingDimension, label: string): TreeNode {
  return { id: `${type}-${id}`, label, type, entityId: id, children: [], runCount: 0, activeCount: 0 }
}

/** Stands in for WorkspaceShell: owns the runs, derives the tree from them via
 *  the real grouping code, and applies optimistic updates the way
 *  applyOptimistic does (upsertById REPLACES the run object wholesale). */
function Harness({ initialRuns, extraNodes = [] }: { initialRuns: Run[]; extraNodes?: TreeNode[] }) {
  const [runs, setRuns] = useState(initialRuns)
  const addOptimistic = (entity: string, data: unknown) => {
    if (entity !== 'run') return
    const next = data as Run
    setRuns(prev => prev.map(r => (r.id === next.id ? next : r)))
  }
  const tree = [...buildGroupTree(runs, [], new TaxonomyRepository([], [], [], [])), ...extraNodes]
  return (
    <HierarchySidebar
      tree={tree}
      dimensions={[]}
      spaces={[]}
      activeSpaceId="spc-1"
      onActivateSpace={vi.fn()}
      onCreateSpace={vi.fn()}
      onRenameSpace={vi.fn()}
      onDeleteSpace={vi.fn()}
      onAdd={vi.fn()}
      onDelete={vi.fn()}
      onRename={(entityId, type, newName) =>
        dispatchRename(entityId, type, newName, {
          run: runs.find(r => r.id === entityId),
          addOptimistic,
        })
      }
    />
  )
}

/** The open inline editor for a row. Queried by testid rather than by display
 *  value: testing-library normalizes whitespace, so an all-spaces draft (the
 *  clear case) is invisible to a value query. */
function renameInput(nodeId: string): HTMLInputElement {
  return screen.getByTestId(`rename-input-${nodeId}`) as HTMLInputElement
}

/** Open the inline editor on a row via its pencil. */
function startRename(nodeId: string) {
  fireEvent.click(screen.getByTestId(`rename-${nodeId}`))
}

/** Open the editor, type `value`, and commit with Enter. */
function rename(nodeId: string, value: string) {
  startRename(nodeId)
  fireEvent.change(renameInput(nodeId), { target: { value } })
  fireEvent.keyDown(renameInput(nodeId), { key: 'Enter' })
}

function patchCalls() {
  return apiFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')
}

beforeEach(() => {
  apiFetch.mockReset()
  // Never resolves: everything asserted below must be true *before* the server
  // answers, which is the whole point of the optimistic paint (R11).
  apiFetch.mockImplementation(() => new Promise(() => {}))
})

describe('HierarchySidebar — run rename', () => {
  it('offers a rename affordance on run rows (runs get no entity kebab)', () => {
    render(<Harness initialRuns={[makeRun()]} />)
    expect(screen.getByTestId(`rename-run-${RUN_ID}`)).toBeInTheDocument()
  })

  it('exposes the run id on hover, so a renamed run stays identifiable (R7)', () => {
    render(<Harness initialRuns={[makeRun({ name: 'PM Vpp project' })]} />)
    expect(screen.getByTitle(RUN_ID)).toHaveTextContent('PM Vpp project')
  })

  // The direct regression test for the removed `node.type !== 'run'` guard in
  // commitRename: with the guard in place, this fires no request at all.
  it('commits a rename on a run node by PATCHing /api/runs/:id with the typed name', () => {
    render(<Harness initialRuns={[makeRun()]} />)
    rename(`run-${RUN_ID}`, 'PM Vpp project')

    expect(patchCalls()).toHaveLength(1)
    const [url, init] = patchCalls()[0]!
    expect(url).toBe(`/api/runs/${RUN_ID}`)
    expect(JSON.parse(init!.body as string)).toEqual({ name: 'PM Vpp project' })
  })

  it('never puts the run id in the rename body — the id is immutable (R4)', () => {
    render(<Harness initialRuns={[makeRun()]} />)
    rename(`run-${RUN_ID}`, 'PM Vpp project')

    const body = JSON.parse(patchCalls()[0]![1]!.body as string)
    expect(body).not.toHaveProperty('id')
    expect(body).not.toHaveProperty('sessionId')
    expect(body).not.toHaveProperty('worktree')
  })

  it('commits on blur as well as Enter', () => {
    render(<Harness initialRuns={[makeRun()]} />)
    startRename(`run-${RUN_ID}`)
    fireEvent.change(renameInput(`run-${RUN_ID}`), { target: { value: 'PM Vpp project' } })
    fireEvent.blur(renameInput(`run-${RUN_ID}`))

    expect(patchCalls()).toHaveLength(1)
    expect(JSON.parse(patchCalls()[0]![1]!.body as string)).toEqual({ name: 'PM Vpp project' })
  })

  it('Escape leaves the name unchanged and fires no request', () => {
    render(<Harness initialRuns={[makeRun({ name: 'PM Vpp project' })]} />)
    startRename(`run-${RUN_ID}`)
    fireEvent.change(renameInput(`run-${RUN_ID}`), { target: { value: 'Something else' } })
    fireEvent.keyDown(renameInput(`run-${RUN_ID}`), { key: 'Escape' })

    expect(apiFetch).not.toHaveBeenCalled()
    expect(screen.getByTestId(`sidebar-node-run-${RUN_ID}`)).toHaveTextContent('PM Vpp project')
  })

  it('clearing the name PATCHes an empty name, and the row reverts to the id (R12)', () => {
    render(<Harness initialRuns={[makeRun({ name: 'PM Vpp project' })]} />)
    rename(`run-${RUN_ID}`, '  ')

    expect(JSON.parse(patchCalls()[0]![1]!.body as string)).toEqual({ name: '' })
    // Not a blank row — `name || id`, never `name ?? id`.
    expect(screen.getByTestId(`sidebar-node-run-${RUN_ID}`)).toHaveTextContent(RUN_ID)
  })
})

describe('HierarchySidebar — rename optimism (R11)', () => {
  it('repaints the row with the new name before the server responds', () => {
    render(<Harness initialRuns={[makeRun()]} />)
    // Before: the row shows the raw id.
    expect(screen.getByTestId(`sidebar-node-run-${RUN_ID}`)).toHaveTextContent(RUN_ID)

    rename(`run-${RUN_ID}`, 'PM Vpp project')

    // The PATCH is still in flight (the mock never resolves) and no SSE echo has
    // arrived — yet the label already reads the new name.
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId(`sidebar-node-run-${RUN_ID}`)).toHaveTextContent('PM Vpp project')
  })

  it('optimistically hands the whole run to the store, not an {id, name} stub', () => {
    // applyOptimistic REPLACES the run in state (upsertById), so a stub would
    // wipe status/color/worktree until the SSE echo landed.
    const addOptimistic = vi.fn()
    const run = makeRun()
    dispatchRename(RUN_ID, 'run', 'PM Vpp project', { run, addOptimistic })

    expect(addOptimistic).toHaveBeenCalledWith('run', { ...run, name: 'PM Vpp project' })
  })

  it('optimistically clears the name to undefined for an empty rename', () => {
    const addOptimistic = vi.fn()
    dispatchRename(RUN_ID, 'run', '   ', { run: makeRun({ name: 'PM Vpp project' }), addOptimistic })

    const [, patched] = addOptimistic.mock.calls[0]!
    expect((patched as Run).name).toBeUndefined()
  })
})

describe('dispatchRename — taxonomy entities keep their own endpoints', () => {
  it('routes a task rename to /api/tasks/:id, not the run route', () => {
    render(<Harness initialRuns={[]} extraNodes={[taxonomyNode('tsk-1', 'task', 'Old task name')]} />)
    rename('task-tsk-1', 'New task name')

    expect(patchCalls()).toHaveLength(1)
    const [url, init] = patchCalls()[0]!
    expect(url).toBe('/api/tasks/tsk-1')
    expect(url).not.toContain('/api/runs/')
    expect(JSON.parse(init!.body as string)).toEqual({ name: 'New task name' })
  })

  it.each([
    ['initiative', '/api/initiatives/x'],
    ['epic', '/api/epics/x'],
    ['task', '/api/tasks/x'],
    ['worktree', '/api/worktrees/x'],
  ] as const)('routes %s renames to %s', (type, url) => {
    dispatchRename('x', type, 'New name')
    expect(apiFetch).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'PATCH' }))
  })

  it('still refuses to commit an empty name for a taxonomy entity', () => {
    render(<Harness initialRuns={[]} extraNodes={[taxonomyNode('tsk-1', 'task', 'Old task name')]} />)
    rename('task-tsk-1', '   ')

    // A nameless task is meaningless — unlike a run, which falls back to its id.
    expect(apiFetch).not.toHaveBeenCalled()
  })
})

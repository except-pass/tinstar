// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RunRepository, TaxonomyRepository } from '../../domain/repositories'
import type { Run } from '../../domain/types'

const harness = vi.hoisted(() => ({
  backend: null as unknown as Record<string, unknown>,
  createSessionProps: null as null | Record<string, unknown>,
  infiniteCanvasProps: null as null | Record<string, unknown>,
  globalHotkeys: null as null | Record<string, () => void>,
  focusMode: false,
  select: vi.fn(),
  toggleSelect: vi.fn(),
  expandAll: vi.fn(),
}))

vi.mock('../../hooks/useBackendState', () => ({ useBackendState: () => harness.backend }))
vi.mock('../../hooks/useDimensionMeta', () => ({ useDimensionMeta: () => [] }))
vi.mock('../../hooks/useHiddenRuns', () => ({
  useHiddenRuns: () => ({
    hiddenIds: new Set<string>(),
    isHidden: () => false,
    toggleHidden: vi.fn(),
    removeHidden: vi.fn(),
  }),
}))
vi.mock('../../hooks/useOnboardingState', () => ({ useOnboardingState: () => ({ active: null }) }))
vi.mock('../../hotkeys/useGlobalHotkeys', () => ({
  useGlobalHotkeys: (handlers: Record<string, () => void>) => {
    harness.globalHotkeys = handlers
  },
}))
vi.mock('../../hotkeys/contextRouter', () => ({ useContextRouter: () => undefined }))
vi.mock('../../hotkeys/actionHandlerRegistry', () => ({
  triggerWidgetFlourish: vi.fn(),
  registerActionHandler: vi.fn(),
  deregisterActionHandler: vi.fn(),
}))
vi.mock('../../lib/uiPrefs', () => ({
  PREFS_STORAGE_KEY: 'tinstar-test-prefs',
  getPref: vi.fn((key: string) => key === 'focusMode' ? harness.focusMode : undefined),
  setPref: vi.fn(),
}))
vi.mock('../../context/ConfigContext', () => ({
  useConfig: () => null,
  useConfigPatch: () => vi.fn(async () => undefined),
}))
vi.mock('../../widgets', () => ({ pluginsReady: Promise.resolve() }))

vi.mock('../SelectionProvider', () => ({
  SelectionProvider: ({ children }: { children: ReactNode }) => children,
  useSelection: () => ({
    select: harness.select,
    toggleSelect: harness.toggleSelect,
    deselect: vi.fn(),
    expandAll: harness.expandAll,
    selectedCount: 0,
    state: { selectedType: null, selectedIds: new Set<string>() },
  }),
}))
vi.mock('../../hotkeys/FocusPathContext', () => ({
  FocusPathProvider: ({ children }: { children: ReactNode }) => children,
  useFocusPath: () => ({
    path: [],
    chordState: null,
    pushFocus: vi.fn(),
    clearFocus: vi.fn(),
    setChord: vi.fn(),
    clearChord: vi.fn(),
  }),
}))
vi.mock('../../hotkeys/ConstellationContext', () => ({
  ConstellationProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../TaxonomyContext', () => ({
  TaxonomyProvider: ({ children }: { children: ReactNode }) => children,
}))

vi.mock('../CreateSessionDialog', () => ({
  CreateSessionDialog: (props: Record<string, unknown>) => {
    harness.createSessionProps = props
    return null
  },
}))
vi.mock('../InfiniteCanvas', () => ({
  InfiniteCanvas: (props: Record<string, unknown>) => {
    harness.infiniteCanvasProps = props
    return null
  },
}))

for (const path of [
  '../CreateEntityDialog', '../SettingsDialog', '../HierarchySidebar', '../EntityMenu',
  '../EntitySettingsDialog', '../../core/pluginApi/PinsBridge', '../NoTasksToast',
  '../DownloadPushToast', '../HotkeyPalette', '../OnboardingCanvas', '../PluginFailedBanner',
  '../WidgetsPalette/WidgetsPalette', '../WidgetsPalette/PaletteDragGhost', '../FocusModeToggle',
]) {
  vi.doMock(path, () => ({
    default: () => null,
    CreateEntityDialog: () => null,
    SettingsDialog: () => null,
    EntityMenu: () => null,
    EntitySettingsDialog: () => null,
    PinsBridge: () => null,
    NoTasksToast: () => null,
    DownloadPushToast: () => null,
    HotkeyPalette: () => null,
    OnboardingCanvas: () => null,
    PluginFailedBanner: () => null,
    WidgetsPalette: () => null,
    PaletteDragGhost: () => null,
    FocusModeToggle: () => null,
  }))
}

const { default: WorkspaceShell } = await import('../WorkspaceShell')

describe('WorkspaceShell optimistic session lifecycle', () => {
  beforeEach(() => {
    harness.createSessionProps = null
    harness.infiniteCanvasProps = null
    harness.globalHotkeys = null
    harness.focusMode = false
    harness.select.mockReset()
    harness.toggleSelect.mockReset()
    harness.expandAll.mockReset()
    harness.backend = {
      runRepo: new RunRepository([]),
      taxRepo: new TaxonomyRepository([], [], [], []),
      spaces: [{ id: 'space-1', name: 'Space 1', labelConfig: { levels: [] } }],
      activeSpaceId: 'space-1',
      readyQueue: [],
      addOptimistic: vi.fn(),
      editorWidgets: [],
      browserWidgets: [],
      imageWidgets: [],
      pluginWidgets: [],
      connected: true,
      loading: false,
    }
  })

  it('resolves session-backed placement only after provisioning succeeds', async () => {
    render(<WorkspaceShell />)
    await waitFor(() => expect(harness.infiniteCanvasProps).not.toBeNull())

    const placementCreated = vi.fn()
    act(() => {
      const requestCreate = harness.infiniteCanvasProps?.onRequestCreateSession as
        | ((prefill: Record<string, unknown>, onCreated: (sessionId: string) => void) => void)
        | undefined
      requestCreate?.({}, placementCreated)
    })
    await waitFor(() => expect(harness.createSessionProps).not.toBeNull())

    const intent = { id: 'optimistic-run', prompt: 'keep this prompt' }
    act(() => {
      ;(harness.createSessionProps?.onCreateStarted as ((value: typeof intent) => void))(intent)
    })
    expect(placementCreated).not.toHaveBeenCalled()

    act(() => {
      ;(harness.createSessionProps?.onCreateFailed as ((value: typeof intent, message: string) => void))(intent, 'ttyd failed')
    })
    expect(placementCreated).not.toHaveBeenCalled()

    act(() => {
      ;(harness.createSessionProps?.onCreated as ((sessionId: string) => void))('optimistic-run')
    })
    expect(placementCreated).toHaveBeenCalledOnce()
    expect(placementCreated).toHaveBeenCalledWith('optimistic-run')
  })

  it('expands hierarchy ancestors when cycling to a run workspace in Focus mode', async () => {
    harness.focusMode = true
    harness.backend = {
      ...harness.backend,
      runRepo: new RunRepository([{
        id: 'run-one',
        sessionId: 'session-one',
        status: 'idle',
        spaceId: 'space-1',
        scope: { project: 'tinstar', worktree: 'hierarchyexpand' },
      } as Run]),
      readyQueue: ['session-one'],
    }

    render(<WorkspaceShell />)
    await waitFor(() => expect(harness.globalHotkeys).not.toBeNull())

    act(() => harness.globalHotkeys?.onCycleReadyPrev?.())

    expect(harness.expandAll).toHaveBeenCalledWith([
      'project-tinstar',
      'worktree-tinstar--hierarchyexpand',
    ])
    expect(harness.select).toHaveBeenCalledWith('run-run-one', 'run')
  })
})

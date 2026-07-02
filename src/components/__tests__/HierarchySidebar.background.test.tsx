// @vitest-environment jsdom
//
// U6 (R8/R9): "show background (N)" toggle in the hierarchy header + the
// background marking on revealed sidebar run rows. The heavy sidebar deps
// (selection, drag, inbox, hotkeys, plugin registry) are mocked out — these
// tests exercise the toggle button contract and the row badge/dim treatment.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { TreeNode } from '../../domain/types'
import HierarchySidebar from '../HierarchySidebar'

vi.mock('../../lib/uiPrefs', () => ({
  getPref: vi.fn(() => undefined),
  setPref: vi.fn(),
  getSidebarView: vi.fn(() => 'hierarchy'),
  setSidebarView: vi.fn(),
}))

vi.mock('../../hooks/useInbox', () => ({
  useInbox: () => ({ rows: [], unreadCount: 0 }),
}))

vi.mock('../InboxList', () => ({
  InboxList: () => null,
}))

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

vi.mock('../../hooks/useDimensionMeta', () => ({
  useDimensionMeta: () => [],
}))

vi.mock('../../hotkeys/ConstellationContext', () => ({
  useConstellationContext: () => ({ slotsForNode: () => [], remove: vi.fn() }),
}))

vi.mock('../../hotkeys/FocusPathContext', () => ({
  useHotkeyContext: () => ({ path: [], chordState: null, activeDefinition: null }),
}))

vi.mock('../../hotkeys/bindingFiredBus', () => ({
  onBindingFired: () => () => {},
}))

vi.mock('../HotkeyBindingRow', () => ({
  BindingRow: () => null,
  GLOBAL_KEYS: [],
  CANVAS_KEYS: [],
  QUICKDRAW_KEYS: [],
}))

vi.mock('../SpaceSwitcher', () => ({
  SpaceSwitcher: () => null,
}))

vi.mock('../../hooks/usePluginWidgetRegistry', () => ({
  usePluginWidgetRegistry: () => ({ entries: [], error: null, iconByType: new Map() }),
}))

vi.mock('../agentIcon', () => ({
  AgentIcon: () => null,
  isIconUrl: () => false,
}))

beforeEach(() => {
  vi.clearAllMocks()
})

function runNode(id: string, overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: `run-${id}`,
    label: id,
    type: 'run',
    entityId: id,
    children: [],
    runCount: 0,
    activeCount: 0,
    status: 'idle',
    ...overrides,
  }
}

function renderSidebar(props: Partial<React.ComponentProps<typeof HierarchySidebar>> = {}) {
  const base: React.ComponentProps<typeof HierarchySidebar> = {
    tree: [],
    dimensions: [],
    spaces: [],
    activeSpaceId: 'spc-1',
    onActivateSpace: vi.fn(),
    onCreateSpace: vi.fn(),
    onRenameSpace: vi.fn(),
    onDeleteSpace: vi.fn(),
    onAdd: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
  }
  return render(<HierarchySidebar {...base} {...props} />)
}

describe('HierarchySidebar background toggle', () => {
  it('renders the toggle with the count and calls onToggleShowBackground on click', () => {
    const onToggle = vi.fn()
    renderSidebar({
      showBackgroundSessions: false,
      onToggleShowBackground: onToggle,
      backgroundCount: 2,
    })
    const btn = screen.getByTestId('sidebar-background-toggle')
    expect(btn).toHaveAttribute('title', 'Show background sessions (2)')
    expect(screen.getByTestId('sidebar-background-toggle-count').textContent).toBe('2')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('is not rendered when onToggleShowBackground is absent', () => {
    renderSidebar()
    expect(screen.queryByTestId('sidebar-background-toggle')).toBeNull()
  })

  it('updates the count when the prop changes', () => {
    const onToggle = vi.fn()
    const { rerender } = renderSidebar({
      showBackgroundSessions: false,
      onToggleShowBackground: onToggle,
      backgroundCount: 1,
    })
    expect(screen.getByTestId('sidebar-background-toggle-count').textContent).toBe('1')
    rerender(
      <HierarchySidebar
        tree={[]}
        dimensions={[]}
        spaces={[]}
        activeSpaceId="spc-1"
        onActivateSpace={vi.fn()}
        onCreateSpace={vi.fn()}
        onRenameSpace={vi.fn()}
        onDeleteSpace={vi.fn()}
        onAdd={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
        showBackgroundSessions={false}
        onToggleShowBackground={onToggle}
        backgroundCount={3}
      />,
    )
    expect(screen.getByTestId('sidebar-background-toggle-count').textContent).toBe('3')
  })

  it('renders "(0)" and stays clickable — informational, never disabled (R9)', () => {
    const onToggle = vi.fn()
    renderSidebar({
      showBackgroundSessions: false,
      onToggleShowBackground: onToggle,
      backgroundCount: 0,
    })
    const btn = screen.getByTestId('sidebar-background-toggle')
    expect(btn).not.toBeDisabled()
    expect(btn).toHaveAttribute('title', 'Show background sessions (0)')
    expect(screen.getByTestId('sidebar-background-toggle-count').textContent).toBe('0')
    fireEvent.click(btn)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('reflects the on state in title and aria-pressed', () => {
    renderSidebar({
      showBackgroundSessions: true,
      onToggleShowBackground: vi.fn(),
      backgroundCount: 2,
    })
    const btn = screen.getByTestId('sidebar-background-toggle')
    expect(btn).toHaveAttribute('title', 'Hide background sessions (2)')
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })
})

describe('HierarchySidebar background row marking', () => {
  it('marks revealed background rows with the badge and dim; leaves other rows unmarked', () => {
    renderSidebar({
      tree: [runNode('bg-1'), runNode('fg-1')],
      showBackgroundSessions: true,
      onToggleShowBackground: vi.fn(),
      backgroundCount: 1,
      backgroundRunIds: new Set(['bg-1']),
    })
    expect(screen.getByTestId('sidebar-background-badge-run-bg-1')).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-background-badge-run-fg-1')).toBeNull()
    expect(screen.getByTestId('sidebar-node-run-bg-1').className).toContain('opacity-50')
    expect(screen.getByTestId('sidebar-node-run-fg-1').className).not.toContain('opacity-50')
  })

  it('renders no badges when backgroundRunIds is absent', () => {
    renderSidebar({ tree: [runNode('r1')] })
    expect(screen.queryByTestId('sidebar-background-badge-run-r1')).toBeNull()
  })
})

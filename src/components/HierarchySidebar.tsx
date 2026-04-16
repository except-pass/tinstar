import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import type { TreeNode, GroupingDimension, Space } from '../domain/types'
import { getDimensionIcon } from '../domain/dimension-meta'
import { useDimensionMeta } from '../hooks/useDimensionMeta'
import { useSelection } from './SelectionProvider'
import { useSidebarDrag, type DropTarget } from '../hooks/useSidebarDrag'
import { SpaceSwitcher } from './SpaceSwitcher'
import { useHotgroupContext } from '../hotkeys/HotgroupContext'
import { HotgroupBadge } from './HotgroupBadge'
import { useHotkeyContext } from '../hotkeys/FocusPathContext'
import { onBindingFired } from '../hotkeys/bindingFiredBus'
import type { Binding, WidgetContext } from '../hotkeys/widgetTypes'
import { BindingRow, GLOBAL_KEYS, CANVAS_KEYS, QUICKDRAW_KEYS } from './HotkeyBindingRow'
import { AgentIcon, isIconUrl } from './agentIcon'

const LS_HOTKEYS_HEIGHT = 'tinstar-sidebar-hotkeys-height'
const DEFAULT_HOTKEYS_HEIGHT = 200
const MIN_HOTKEYS_HEIGHT = 28
const MAX_HOTKEYS_HEIGHT = 600

function HotkeysSection({ height }: { height: number }) {
  const { path, chordState, activeDefinition } = useHotkeyContext()
  const [firedCounts, setFiredCounts] = useState<Record<string, number>>({})

  useEffect(() => onBindingFired((key) => {
    setFiredCounts(c => ({ ...c, [key]: (c[key] ?? 0) + 1 }))
  }), [])

  const contextLabel = activeDefinition?.displayName ?? 'Canvas'
  const isTerminal = activeDefinition?.type === 'run-terminal'

  const activeBindings: Binding[] = activeDefinition
    ? (chordState ? activeDefinition.bindings.filter(b => b.chord) : activeDefinition.bindings.filter(b => !b.chord))
    : []
  const activeContexts: WidgetContext[] = (!chordState && activeDefinition) ? activeDefinition.contexts : []

  return (
    <div className="flex-shrink-0 flex flex-col overflow-hidden" style={{ height }}>
      {/* Section label */}
      <div className="px-3 py-1.5 flex-shrink-0">
        <span className={`text-2xs font-mono font-bold uppercase tracking-widest ${chordState ? 'text-primary' : 'text-slate-500'}`}>
          {chordState ? '⌨ Chord' : contextLabel}
        </span>
      </div>

      {/* Scrollable bindings */}
      <div className="overflow-y-auto scrollbar-thin flex-1 px-2 pb-1.5">
        {isTerminal ? (
          <div className="text-2xs text-slate-600 italic py-0.5">terminal owns keyboard</div>
        ) : (
          <>
            {activeContexts.map(c => (
              <BindingRow key={c.key} binding={{ key: c.key, label: `${c.label} →` }} fireCount={firedCounts[c.key] ?? 0} />
            ))}
            {activeBindings.map(b => (
              <BindingRow key={b.key} binding={b} fireCount={firedCounts[b.key] ?? 0} />
            ))}
            {activeBindings.length === 0 && activeContexts.length === 0 && (
              <div className="text-2xs text-slate-600 italic py-0.5">no bindings</div>
            )}
            {path.length > 0 && (
              <BindingRow binding={{ key: '`', label: 'Canvas root' }} fireCount={firedCounts['`'] ?? 0} />
            )}
            <div className="border-t border-white/10 my-1" />
            <div className="text-2xs font-mono font-bold text-slate-600 uppercase tracking-widest mb-1">Global</div>
            {GLOBAL_KEYS.map(b => (
              <BindingRow key={b.key} binding={b} fireCount={firedCounts[b.key] ?? 0} />
            ))}
            <div className="border-t border-white/10 my-1" />
            <div className="text-2xs font-mono font-bold text-slate-600 uppercase tracking-widest mb-1">Canvas</div>
            {CANVAS_KEYS.map(b => (
              <BindingRow key={b.key} binding={b} fireCount={firedCounts[b.key] ?? 0} />
            ))}
            <div className="border-t border-white/10 my-1" />
            <div className="text-2xs font-mono font-bold text-slate-600 uppercase tracking-widest mb-1">Quick Draw</div>
            {QUICKDRAW_KEYS.map(b => (
              <BindingRow key={b.key} binding={b} fireCount={firedCounts[b.key] ?? 0} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

interface HierarchySidebarProps {
  tree: TreeNode[]
  unfilteredTree?: TreeNode[]
  dimensions: GroupingDimension[]
  spaces: Space[]
  activeSpaceId: string
  showEmptyEntities?: boolean
  onToggleShowEmpty?: () => void
  onActivateSpace: (id: string) => void
  onCreateSpace: (name: string) => void
  onRenameSpace: (id: string, name: string) => void
  onDeleteSpace: (id: string) => void
  onAdd: (parentId: string | null, type: GroupingDimension | 'run') => void
  onRename: (entityId: string, type: GroupingDimension, newName: string) => void
  onDelete: (entityId: string, type: GroupingDimension) => void
  onFocusRun?: (runId: string) => void
  onMenuOpen?: (entityId: string, entityType: GroupingDimension, entityName: string, anchorRect: DOMRect) => void
  onReparent?: (entityId: string, entityType: string, newParentId: string | null, newParentType: string | null) => void
  onCollapse?: () => void
  renamingNodeId?: string | null
  onRenameComplete?: () => void
  hiddenRunIds?: Set<string>
  onToggleRunHidden?: (runId: string) => void
}

/** Metadata for all Work Widget types — drives sidebar icons, badge, close button, and focus behavior */
const WORK_WIDGET_META: Record<string, { icon: string; closeable: boolean }> = {
  'run':            { icon: '▶',  closeable: false },  // icon overridden per-node for docker backend
  'file-editor':    { icon: '📄', closeable: true  },
  'browser-widget': { icon: '🌐', closeable: true  },
  'image-viewer':   { icon: '🖼️', closeable: true  },
  'nats-traffic':   { icon: '📡', closeable: true  },
}

/** Return inline style for a colored status dot on run nodes */
function statusDotStyle(node: TreeNode): React.CSSProperties | undefined {
  if (node.type !== 'run') return undefined
  return { backgroundColor: node.color ?? '#94a3b8' }
}

function nextChildType(type: GroupingDimension | 'run', dimensions: GroupingDimension[]): GroupingDimension | 'run' {
  if (type === 'run') return 'run'
  const idx = dimensions.indexOf(type)
  if (idx === -1 || idx === dimensions.length - 1) return 'run'
  return dimensions[idx + 1]!
}

function SidebarNode({
  node,
  depth,
  dimensions,
  dimensionIconMap,
  onAdd,
  onRename,
  onDelete,
  onFocusRun,
  onMenuOpen,
  dragNodeId,
  dropTarget,
  onDragStart,
  renamingNodeId,
  onRenameComplete,
  hiddenRunIds,
  onToggleRunHidden,
}: {
  node: TreeNode
  depth: number
  dimensions: GroupingDimension[]
  dimensionIconMap: Record<string, string>
  onAdd: HierarchySidebarProps['onAdd']
  onRename: HierarchySidebarProps['onRename']
  onDelete: HierarchySidebarProps['onDelete']
  onFocusRun?: (runId: string) => void
  onMenuOpen?: HierarchySidebarProps['onMenuOpen']
  dragNodeId: string | null
  dropTarget: DropTarget | null
  onDragStart?: (nodeId: string, nodeType: string, label: string, clientY: number, clientX: number) => void
  renamingNodeId?: string | null
  onRenameComplete?: () => void
  hiddenRunIds?: Set<string>
  onToggleRunHidden?: (runId: string) => void
}) {
  const { isSelected, isExpanded, isHovered, select, toggleSelect, hover, toggleExpand } = useSelection()
  const { slotsForNode } = useHotgroupContext()
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = isSelected(node.id)
  const expanded = isExpanded(node.id)
  const hovered = isHovered(node.id)
  const hasChildren = node.children.length > 0
  const isRun = node.type === 'run'
  const isWorkWidget = node.type in WORK_WIDGET_META
  const runHidden = isRun && hiddenRunIds?.has(node.entityId) === true
  const isDragging = dragNodeId === node.id
  const isDropInside = dropTarget?.nodeId === node.id && dropTarget?.position === 'inside'
  const isDropBefore = dropTarget?.nodeId === node.id && dropTarget?.position === 'before'
  const isDropAfter = dropTarget?.nodeId === node.id && dropTarget?.position === 'after'

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  useEffect(() => {
    if (renamingNodeId === node.id && !editing) {
      setEditValue(node.label)
      setEditing(true)
    }
  }, [renamingNodeId, node.id, node.label, editing])

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== node.label && node.type !== 'run') {
      onRename(node.entityId, node.type as GroupingDimension, trimmed)
    }
    setEditing(false)
    onRenameComplete?.()
  }, [editValue, node, onRename, onRenameComplete])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || editing) return
    if (onDragStart) {
      onDragStart(node.id, node.type, node.label, e.clientY, e.clientX)
    }
  }, [node, editing, onDragStart])

  return (
    <div>
      {/* Drop indicator: before */}
      {isDropBefore && (
        <div
          className="h-0.5 bg-primary mx-2 rounded-full"
          style={{ marginLeft: `${depth * 16 + 8}px` }}
          data-testid={`drop-before-${node.id}`}
        />
      )}

      <div
        className={[
          'group flex items-center gap-1 px-2 py-1 cursor-pointer text-xs',
          'hover:bg-surface-hover transition-colors',
          selected ? 'bg-primary/20 text-primary neon-border' : '',
          hovered && !isDragging ? 'bg-surface-hover' : '',
          isDragging ? 'opacity-40' : '',
          isDropInside ? 'bg-primary/10 ring-1 ring-primary/40' : '',
          runHidden ? 'opacity-50' : '',
        ].join(' ')}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        data-testid={`sidebar-node-${node.id}`}
        data-drag-node-id={node.id}
        data-drag-node-type={node.type}
        onPointerDown={handlePointerDown}
        onClick={(e) => {
          if (editing || dragNodeId) return
          if (e.ctrlKey || e.metaKey) {
            toggleSelect(node.id, node.type as GroupingDimension | 'run' | 'file-editor')
          } else {
            select(node.id, node.type as GroupingDimension | 'run' | 'file-editor')
          }
        }}
        onDoubleClick={() => {
          if (hasChildren) toggleExpand(node.id)
          if (isWorkWidget && onFocusRun) onFocusRun(node.id)
        }}
        onMouseEnter={() => hover(node.id)}
        onMouseLeave={() => hover(null)}
      >
        {/* Expand/collapse chevron */}
        {hasChildren ? (
          <button
            className="w-4 h-4 flex items-center justify-center text-slate-400 hover:text-slate-200"
            onClick={(e) => {
              e.stopPropagation()
              toggleExpand(node.id)
            }}
            data-testid={`chevron-${node.id}`}
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4" />
        )}

        {/* Icon */}
        <span className="w-4 h-4 flex items-center justify-center flex-shrink-0" aria-hidden="true">
          {node.type === 'run'
            ? (isIconUrl(node.agentIcon)
                ? <AgentIcon icon={node.agentIcon} />
                : (node.agentIcon ?? (node.backend === 'docker' ? '🐳' : '▶')))
            : (WORK_WIDGET_META[node.type]?.icon ?? dimensionIconMap[node.type as GroupingDimension] ?? getDimensionIcon(node.type))}
        </span>

        {/* Color dot */}
        {isRun ? (
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={statusDotStyle(node)}
            data-testid={`status-dot-${node.id}`}
            aria-hidden="true"
          />
        ) : node.color ? (
          <span
            className="w-2 h-2 rounded-sm flex-shrink-0"
            style={{ backgroundColor: node.color }}
            aria-hidden="true"
          />
        ) : null}

        {/* Label (inline edit or static) */}
        {editing ? (
          <input
            ref={inputRef}
            className="flex-1 bg-surface-base border border-primary/40 rounded px-1 py-0 text-xs text-slate-200 outline-none"
            value={editValue}
            onChange={e => setEditValue(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setEditing(false)
            }}
            onBlur={commitRename}
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <span className="truncate flex-1">
            {node.type === 'task' && node.status === 'completed' && <span className="mr-1">✅</span>}
            {node.label}
          </span>
        )}

        {/* Hotgroup badge for all work widgets */}
        {isWorkWidget && !editing && (
          <HotgroupBadge slots={slotsForNode(node.id)} testId={`sidebar-hotgroup-badge-${node.id}`} />
        )}

        {/* Visibility eyeball — runs only.
            Hidden runs show the closed eye permanently so they can be restored.
            Visible runs show the open eye on hover/selected, matching the other row actions. */}
        {isRun && !editing && onToggleRunHidden && (
          <button
            className={[
              'w-4 h-4 flex items-center justify-center text-slate-500 hover:text-primary transition-opacity',
              runHidden ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
            ].join(' ')}
            onClick={(e) => {
              e.stopPropagation()
              onToggleRunHidden(node.entityId)
            }}
            data-testid={`run-visibility-${node.id}`}
            aria-label={runHidden ? `Show ${node.label}` : `Hide ${node.label}`}
            title={runHidden ? 'Show on canvas' : 'Hide from canvas'}
            style={{ opacity: runHidden || hovered ? 1 : undefined }}
          >
            <span className="material-symbols-outlined text-sm leading-none">
              {runHidden ? 'visibility_off' : 'visibility'}
            </span>
          </button>
        )}

        {/* Count badge */}
        {!isRun && node.runCount > 0 && !editing && (
          <span className="text-2xs bg-surface-raised px-1.5 py-0.5 rounded-full text-slate-400">
            {node.runCount}
          </span>
        )}

        {/* Close button for closeable work widgets */}
        {WORK_WIDGET_META[node.type]?.closeable && !editing && (
          <button
            className="w-4 h-4 flex items-center justify-center text-slate-500 hover:text-accent-red opacity-0 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(node.entityId, node.type as GroupingDimension)
            }}
            aria-label={`Close ${node.label}`}
            style={{ opacity: hovered ? 1 : undefined }}
          >
            ×
          </button>
        )}

        {/* Kebab menu button */}
        {!isWorkWidget && !editing && onMenuOpen && (
          <button
            className="w-4 h-4 flex items-center justify-center text-slate-500 hover:text-primary opacity-0 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              onMenuOpen(node.entityId, node.type as GroupingDimension, node.label, rect)
            }}
            data-testid={`menu-${node.id}`}
            aria-label={`Menu for ${node.label}`}
            style={{ opacity: hovered ? 1 : undefined }}
          >
            ⋮
          </button>
        )}

        {/* Fallback: individual buttons when onMenuOpen is not provided */}
        {!isWorkWidget && !editing && !onMenuOpen && (
          <>
            <button
              className="w-4 h-4 flex items-center justify-center text-slate-500 hover:text-primary opacity-0 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                setEditValue(node.label)
                setEditing(true)
              }}
              data-testid={`rename-${node.id}`}
              aria-label={`Rename ${node.label}`}
              style={{ opacity: hovered ? 1 : undefined }}
            >
              ✏
            </button>
            <button
              className="w-4 h-4 flex items-center justify-center text-slate-500 hover:text-primary opacity-0 group-hover:opacity-100 hover:!opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                onAdd(node.entityId, nextChildType(node.type as GroupingDimension | 'run', dimensions))
              }}
              data-testid={`add-child-${node.id}`}
              aria-label={`Add ${nextChildType(node.type as GroupingDimension | 'run', dimensions)}`}
              style={{ opacity: hovered ? 1 : undefined }}
            >
              +
            </button>
            <button
              className="w-4 h-4 flex items-center justify-center text-slate-500 hover:text-red-400 opacity-0 group-hover:opacity-100 hover:!opacity-100"
              onClick={(e) => {
                e.stopPropagation()
                onDelete(node.entityId, node.type as GroupingDimension)
              }}
              data-testid={`delete-${node.id}`}
              aria-label={`Delete ${node.label}`}
              style={{ opacity: hovered ? 1 : undefined }}
            >
              ×
            </button>
          </>
        )}
      </div>

      {/* Progress bar for task nodes with percentDone */}
      {node.type === 'task' && node.percentDone != null && (
        <div className="h-px bg-surface-raised mx-2">
          <div
            className="h-px bg-primary"
            style={{ width: `${Math.min(100, Math.max(0, node.percentDone))}%` }}
          />
        </div>
      )}

      {/* Children (when expanded) */}
      {hasChildren && expanded && (
        <div data-testid={`children-${node.id}`}>
          {node.children.map(child => (
            <SidebarNode
              key={child.id}
              node={child}
              depth={depth + 1}
              dimensions={dimensions}
              dimensionIconMap={dimensionIconMap}
              onAdd={onAdd}
              onRename={onRename}
              onDelete={onDelete}
              onFocusRun={onFocusRun}
              onMenuOpen={onMenuOpen}
              dragNodeId={dragNodeId}
              dropTarget={dropTarget}
              onDragStart={onDragStart}
              renamingNodeId={renamingNodeId}
              onRenameComplete={onRenameComplete}
              hiddenRunIds={hiddenRunIds}
              onToggleRunHidden={onToggleRunHidden}
            />
          ))}
        </div>
      )}

      {/* Drop indicator: after */}
      {isDropAfter && (
        <div
          className="h-0.5 bg-primary mx-2 rounded-full"
          style={{ marginLeft: `${depth * 16 + 8}px` }}
          data-testid={`drop-after-${node.id}`}
        />
      )}
    </div>
  )
}

function OrphanSeparator() {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 my-1">
      <div className="flex-1 border-t border-white/10" />
      <span className="text-2xs text-slate-500 uppercase tracking-wider">Ungrouped</span>
      <div className="flex-1 border-t border-white/10" />
    </div>
  )
}

function TreeWithOrphanSeparators({
  nodes,
  depth,
  dimensions,
  dimensionIconMap,
  onAdd,
  onRename,
  onDelete,
  onFocusRun,
  onMenuOpen,
  dragNodeId,
  dropTarget,
  onDragStart,
  renamingNodeId,
  onRenameComplete,
  hiddenRunIds,
  onToggleRunHidden,
}: {
  nodes: TreeNode[]
  depth: number
  dimensions: GroupingDimension[]
  dimensionIconMap: Record<string, string>
  onAdd: HierarchySidebarProps['onAdd']
  onRename: HierarchySidebarProps['onRename']
  onDelete: HierarchySidebarProps['onDelete']
  onFocusRun?: (runId: string) => void
  onMenuOpen?: HierarchySidebarProps['onMenuOpen']
  dragNodeId: string | null
  dropTarget: DropTarget | null
  onDragStart?: (nodeId: string, nodeType: string, label: string, clientY: number, clientX: number) => void
  renamingNodeId?: string | null
  onRenameComplete?: () => void
  hiddenRunIds?: Set<string>
  onToggleRunHidden?: (runId: string) => void
}) {
  const normal = nodes.filter(n => !n.orphan)
  const orphans = nodes.filter(n => n.orphan)

  return (
    <>
      {normal.map(node => (
        <SidebarNode
          key={node.id}
          node={node}
          depth={depth}
          dimensions={dimensions}
          dimensionIconMap={dimensionIconMap}
          onAdd={onAdd}
          onRename={onRename}
          onDelete={onDelete}
          onFocusRun={onFocusRun}
          onMenuOpen={onMenuOpen}
          dragNodeId={dragNodeId}
          dropTarget={dropTarget}
          onDragStart={onDragStart}
          renamingNodeId={renamingNodeId}
          onRenameComplete={onRenameComplete}
          hiddenRunIds={hiddenRunIds}
          onToggleRunHidden={onToggleRunHidden}
        />
      ))}
      {orphans.length > 0 && <OrphanSeparator />}
      {orphans.map(node => (
        <SidebarNode
          key={node.id}
          node={node}
          depth={depth}
          dimensions={dimensions}
          dimensionIconMap={dimensionIconMap}
          onAdd={onAdd}
          onRename={onRename}
          onDelete={onDelete}
          onFocusRun={onFocusRun}
          onMenuOpen={onMenuOpen}
          dragNodeId={dragNodeId}
          dropTarget={dropTarget}
          onDragStart={onDragStart}
          renamingNodeId={renamingNodeId}
          onRenameComplete={onRenameComplete}
          hiddenRunIds={hiddenRunIds}
          onToggleRunHidden={onToggleRunHidden}
        />
      ))}
    </>
  )
}

export default function HierarchySidebar({ tree, unfilteredTree, dimensions, spaces, activeSpaceId, showEmptyEntities, onToggleShowEmpty, onActivateSpace, onCreateSpace, onRenameSpace, onDeleteSpace, onAdd, onRename, onDelete, onFocusRun, onMenuOpen, onReparent, onArrangeGrid, onArrangeReset, onArrangeSwimlanes, onCollapse, renamingNodeId, onRenameComplete, hiddenRunIds, onToggleRunHidden }: HierarchySidebarProps & { onArrangeGrid?: () => void; onArrangeReset?: () => void; onArrangeSwimlanes?: () => void }) {
  const rootType = dimensions[0] ?? 'initiative'
  const { isExpanded, expandAll } = useSelection()
  const showEmpty = showEmptyEntities ?? true

  const levelMeta = useDimensionMeta()
  const dimensionIconMap = useMemo(
    () => Object.fromEntries(levelMeta.map(m => [m.internalType, m.icon])),
    [levelMeta],
  )
  const dimensionLabelMap = useMemo(
    () => Object.fromEntries(levelMeta.map(m => [m.internalType, m.label])),
    [levelMeta],
  )

  const handleReparent = useCallback((entityId: string, entityType: string, newParentId: string | null, newParentType: string | null) => {
    if (onReparent) onReparent(entityId, entityType, newParentId, newParentType)
  }, [onReparent])

  const {
    dragState,
    dropTarget,
    scrollContainerRef,
    dragInitiated,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
  } = useSidebarDrag(tree, dimensions, isExpanded, (id: string) => expandAll([id]), handleReparent)

  // Hotkeys panel height (resizable by dragging the divider)
  const [hotkeysHeight, setHotkeysHeight] = useState(() => {
    const saved = localStorage.getItem(LS_HOTKEYS_HEIGHT)
    return saved ? Math.max(MIN_HOTKEYS_HEIGHT, Math.min(MAX_HOTKEYS_HEIGHT, parseInt(saved))) : DEFAULT_HOTKEYS_HEIGHT
  })
  const hotkeysHeightRef = useRef(hotkeysHeight)
  hotkeysHeightRef.current = hotkeysHeight
  const dividerDragRef = useRef<{ startY: number; startH: number } | null>(null)

  const onDividerPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    dividerDragRef.current = { startY: e.clientY, startH: hotkeysHeightRef.current }
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (dragInitiated.current || dragState) {
      handleDragMove(e.clientY, e.clientX)
    }
    if (dividerDragRef.current) {
      // Drag up → increase hotkeys height; drag down → decrease
      const delta = dividerDragRef.current.startY - e.clientY
      const newH = Math.max(MIN_HOTKEYS_HEIGHT, Math.min(MAX_HOTKEYS_HEIGHT, dividerDragRef.current.startH + delta))
      setHotkeysHeight(newH)
      localStorage.setItem(LS_HOTKEYS_HEIGHT, String(newH))
    }
  }, [dragState, dragInitiated, handleDragMove])

  const onPointerUp = useCallback(() => {
    handleDragEnd()
    dividerDragRef.current = null
  }, [handleDragEnd])

  return (
    <div
      className="flex flex-col h-full"
      data-testid="hierarchy-sidebar"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    >
      {/* Space switcher header with collapse button */}
      <div className="flex items-center border-b border-white/10">
        <div className="flex-1 min-w-0">
          <SpaceSwitcher
            spaces={spaces}
            activeSpaceId={activeSpaceId}
            onActivate={onActivateSpace}
            onCreate={onCreateSpace}
            onRename={onRenameSpace}
            onDelete={onDeleteSpace}
          />
        </div>
        {onCollapse && (
          <button
            onClick={onCollapse}
            className="px-1 flex-shrink-0 text-slate-500 hover:text-primary"
            aria-label="Collapse sidebar"
          >
            <span className="material-symbols-outlined text-sm">chevron_left</span>
          </button>
        )}
      </div>
      <div className="flex items-center px-3 py-1 border-b border-white/5">
        <div className="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
          {dimensions.map((dim, i) => (
            <span key={dim} className="flex items-center gap-0.5 shrink-0">
              {i > 0 && <span className="text-2xs text-slate-600 mx-0.5">&gt;</span>}
              <span className="text-2xs" aria-hidden>{dimensionIconMap[dim] ?? ''}</span>
              <span className="text-2xs text-slate-500 truncate">{dimensionLabelMap[dim] ?? dim}</span>
            </span>
          ))}
        </div>
        {onToggleShowEmpty && (
          <button
            className={`text-xs shrink-0 mr-1 transition-colors ${showEmpty ? 'text-slate-500 hover:text-primary' : 'text-slate-600 opacity-40 hover:opacity-100'}`}
            onClick={onToggleShowEmpty}
            title={showEmpty ? 'Hide empty entities' : 'Show empty entities'}
            aria-label="Toggle empty entities"
          >
            <span className="material-symbols-outlined text-sm">filter_list</span>
          </button>
        )}
        <button
          className="text-xs text-slate-500 hover:text-primary shrink-0"
          onClick={() => onAdd(null, rootType)}
          data-testid="add-root"
          aria-label={`Add ${rootType}`}
        >
          +
        </button>
      </div>

      {/* Tree */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto scrollbar-thin py-1"
        style={{ cursor: dragState ? 'grabbing' : undefined }}
      >
        {tree.length === 0 ? (
          <div className="px-3 py-4 text-xs text-slate-500 text-center">
            {(unfilteredTree ?? tree).length === 0 ? 'No items. Click + to create.' : 'All entities empty. Click filter to show.'}
          </div>
        ) : (
          <TreeWithOrphanSeparators
            nodes={tree}
            depth={0}
            dimensions={dimensions}
            dimensionIconMap={dimensionIconMap}
            onAdd={onAdd}
            onRename={onRename}
            onDelete={onDelete}
            onFocusRun={onFocusRun}
            onMenuOpen={onMenuOpen}
            dragNodeId={dragState?.nodeId ?? null}
            dropTarget={dropTarget}
            onDragStart={handleDragStart}
            renamingNodeId={renamingNodeId}
            onRenameComplete={onRenameComplete}
            hiddenRunIds={hiddenRunIds}
            onToggleRunHidden={onToggleRunHidden}
          />
        )}
      </div>

      {/* Drag divider between tree and hotkeys */}
      <div
        className="h-1 flex-shrink-0 border-t border-white/10 cursor-row-resize hover:bg-primary/20 active:bg-primary/40 transition-colors"
        onPointerDown={onDividerPointerDown}
      />

      {/* Hotkeys section — height controlled by dragging the divider above */}
      <HotkeysSection height={hotkeysHeight} />

      {/* Tools section */}
      <div className="border-t border-white/10 px-3 py-2 flex items-center gap-2">
        <span className="text-2xs text-slate-500 uppercase tracking-wider">Tools</span>
        <button
          className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-primary rounded hover:bg-white/5 transition-colors"
          onClick={() => fetch('/api/nats-traffic-widgets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })}
          title="Open NATS Traffic Monitor"
        >
          <span className="material-symbols-outlined text-base">cell_tower</span>
        </button>
        {(onArrangeGrid || onArrangeSwimlanes || onArrangeReset) && (
          <div className="w-px h-4 bg-white/10 mx-1" />
        )}
        {onArrangeGrid && (
          <button
            className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-primary rounded hover:bg-white/5 transition-colors"
            onClick={onArrangeGrid}
            title="Tile selected in grid (or all if none selected)"
          >
            <span className="material-symbols-outlined text-base">grid_view</span>
          </button>
        )}
        {onArrangeSwimlanes && (
          <button
            className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-primary rounded hover:bg-white/5 transition-colors"
            onClick={onArrangeSwimlanes}
            title="Swim lanes — rows by task (Ctrl+L)"
          >
            <span className="material-symbols-outlined text-base">view_agenda</span>
          </button>
        )}
        {onArrangeReset && (
          <button
            className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-primary rounded hover:bg-white/5 transition-colors"
            onClick={onArrangeReset}
            data-testid="arrange-button"
            title="Reset layout"
          >
            <span className="material-symbols-outlined text-base">auto_fix_high</span>
          </button>
        )}
      </div>

      {/* Floating drag card */}
      {dragState && (
        <div
          className="fixed pointer-events-none z-50 bg-surface-panel border border-primary/40 rounded px-3 py-1 text-xs text-primary shadow-lg"
          style={{
            top: dragState.currentY - 12,
            left: 16,
            opacity: 0.85,
          }}
          data-testid="drag-ghost"
        >
          {dimensionIconMap[dragState.nodeType as GroupingDimension] ?? getDimensionIcon(dragState.nodeType)} {dragState.label}
        </div>
      )}
    </div>
  )
}

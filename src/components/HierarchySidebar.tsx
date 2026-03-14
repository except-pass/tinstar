import { useState, useRef, useEffect, useCallback } from 'react'
import type { TreeNode, GroupingDimension, Space } from '../domain/types'
import { getDimensionIcon } from '../domain/dimension-meta'
import { useSelection } from './SelectionProvider'
import { useSidebarDrag, type DropTarget } from '../hooks/useSidebarDrag'
import { SpaceSwitcher } from './SpaceSwitcher'
import { useHotgroupContext } from '../hotkeys/HotgroupContext'
import { HotgroupBadge } from './HotgroupBadge'

interface HierarchySidebarProps {
  tree: TreeNode[]
  dimensions: GroupingDimension[]
  spaces: Space[]
  activeSpaceId: string
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
  return dimensions[idx + 1]
}

function SidebarNode({
  node,
  depth,
  dimensions,
  onAdd,
  onRename,
  onDelete,
  onFocusRun,
  onMenuOpen,
  dragNodeId,
  dropTarget,
  onDragStart,
}: {
  node: TreeNode
  depth: number
  dimensions: GroupingDimension[]
  onAdd: HierarchySidebarProps['onAdd']
  onRename: HierarchySidebarProps['onRename']
  onDelete: HierarchySidebarProps['onDelete']
  onFocusRun?: (runId: string) => void
  onMenuOpen?: HierarchySidebarProps['onMenuOpen']
  dragNodeId: string | null
  dropTarget: DropTarget | null
  onDragStart?: (nodeId: string, nodeType: string, label: string, clientY: number, clientX: number) => void
}) {
  const { isSelected, isExpanded, isHovered, select, toggleSelect, hover, toggleExpand } = useSelection()
  const { slotsForRun } = useHotgroupContext()
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const selected = isSelected(node.id)
  const expanded = isExpanded(node.id)
  const hovered = isHovered(node.id)
  const hasChildren = node.children.length > 0
  const isRun = node.type === 'run'
  const isDragging = dragNodeId === node.id
  const isDropInside = dropTarget?.nodeId === node.id && dropTarget?.position === 'inside'
  const isDropBefore = dropTarget?.nodeId === node.id && dropTarget?.position === 'before'
  const isDropAfter = dropTarget?.nodeId === node.id && dropTarget?.position === 'after'

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const commitRename = useCallback(() => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== node.label && node.type !== 'run') {
      onRename(node.entityId, node.type as GroupingDimension, trimmed)
    }
    setEditing(false)
  }, [editValue, node, onRename])

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || editing) return
    if (onDragStart && !isRun) {
      onDragStart(node.id, node.type, node.label, e.clientY, e.clientX)
    }
  }, [node, editing, isRun, onDragStart])

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
        ].join(' ')}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        data-testid={`sidebar-node-${node.id}`}
        data-drag-node-id={node.id}
        data-drag-node-type={node.type}
        onPointerDown={handlePointerDown}
        onClick={(e) => {
          if (editing || dragNodeId) return
          if (e.ctrlKey || e.metaKey) {
            toggleSelect(node.id, node.type)
          } else {
            select(node.id, node.type)
            if (hasChildren) toggleExpand(node.id)
          }
        }}
        onDoubleClick={() => {
          if (onFocusRun) {
            onFocusRun(node.id)
          }
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
        <span className="w-4 text-center" aria-hidden="true">
          {node.type === 'run' ? (node.backend === 'docker' ? '🐳' : '▶') : getDimensionIcon(node.type)}
        </span>

        {/* Status dot for runs */}
        {isRun && (
          <span
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={statusDotStyle(node)}
            data-testid={`status-dot-${node.id}`}
            aria-hidden="true"
          />
        )}

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
          <span className="truncate flex-1">{node.label}</span>
        )}

        {/* Hotgroup badge for runs */}
        {isRun && !editing && (
          <HotgroupBadge slots={slotsForRun(node.id)} testId={`sidebar-hotgroup-badge-${node.id}`} />
        )}

        {/* Count badge */}
        {!isRun && node.runCount > 0 && !editing && (
          <span className="text-2xs bg-surface-raised px-1.5 py-0.5 rounded-full text-slate-400">
            {node.runCount}
          </span>
        )}

        {/* Kebab menu button */}
        {!isRun && !editing && onMenuOpen && (
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
        {!isRun && !editing && !onMenuOpen && (
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
                onAdd(node.entityId, nextChildType(node.type, dimensions))
              }}
              data-testid={`add-child-${node.id}`}
              aria-label={`Add ${nextChildType(node.type, dimensions)}`}
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

      {/* Children (when expanded) */}
      {hasChildren && expanded && (
        <div data-testid={`children-${node.id}`}>
          {node.children.map(child => (
            <SidebarNode
              key={child.id}
              node={child}
              depth={depth + 1}
              dimensions={dimensions}
              onAdd={onAdd}
              onRename={onRename}
              onDelete={onDelete}
              onFocusRun={onFocusRun}
              onMenuOpen={onMenuOpen}
              dragNodeId={dragNodeId}
              dropTarget={dropTarget}
              onDragStart={onDragStart}
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
  onAdd,
  onRename,
  onDelete,
  onFocusRun,
  onMenuOpen,
  dragNodeId,
  dropTarget,
  onDragStart,
}: {
  nodes: TreeNode[]
  depth: number
  dimensions: GroupingDimension[]
  onAdd: HierarchySidebarProps['onAdd']
  onRename: HierarchySidebarProps['onRename']
  onDelete: HierarchySidebarProps['onDelete']
  onFocusRun?: (runId: string) => void
  onMenuOpen?: HierarchySidebarProps['onMenuOpen']
  dragNodeId: string | null
  dropTarget: DropTarget | null
  onDragStart?: (nodeId: string, nodeType: string, label: string, clientY: number, clientX: number) => void
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
          onAdd={onAdd}
          onRename={onRename}
          onDelete={onDelete}
          onFocusRun={onFocusRun}
          onMenuOpen={onMenuOpen}
          dragNodeId={dragNodeId}
          dropTarget={dropTarget}
          onDragStart={onDragStart}
        />
      ))}
      {orphans.length > 0 && <OrphanSeparator />}
      {orphans.map(node => (
        <SidebarNode
          key={node.id}
          node={node}
          depth={depth}
          dimensions={dimensions}
          onAdd={onAdd}
          onRename={onRename}
          onDelete={onDelete}
          onFocusRun={onFocusRun}
          onMenuOpen={onMenuOpen}
          dragNodeId={dragNodeId}
          dropTarget={dropTarget}
          onDragStart={onDragStart}
        />
      ))}
    </>
  )
}

export default function HierarchySidebar({ tree, dimensions, spaces, activeSpaceId, onActivateSpace, onCreateSpace, onRenameSpace, onDeleteSpace, onAdd, onRename, onDelete, onFocusRun, onMenuOpen, onReparent, onArrangeGrid, onArrangeReset, onCollapse }: HierarchySidebarProps & { onArrangeGrid?: () => void; onArrangeReset?: () => void }) {
  const rootType = dimensions[0] ?? 'initiative'
  const { isExpanded, expandAll } = useSelection()

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

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    // Check ref directly — dragState may not be set until threshold is met
    if (dragInitiated.current || dragState) {
      handleDragMove(e.clientY, e.clientX)
    }
  }, [dragState, dragInitiated, handleDragMove])

  const onPointerUp = useCallback(() => {
    handleDragEnd()
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
      <div className="flex items-center justify-end px-3 py-1 border-b border-white/5">
        <button
          className="text-xs text-slate-500 hover:text-primary"
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
            No items. Click + to create.
          </div>
        ) : (
          <TreeWithOrphanSeparators
            nodes={tree}
            depth={0}
            dimensions={dimensions}
            onAdd={onAdd}
            onRename={onRename}
            onDelete={onDelete}
            onFocusRun={onFocusRun}
            onMenuOpen={onMenuOpen}
            dragNodeId={dragState?.nodeId ?? null}
            dropTarget={dropTarget}
            onDragStart={handleDragStart}
          />
        )}
      </div>

      {/* Arrange section */}
      {(onArrangeGrid || onArrangeReset) && (
        <div className="border-t border-white/10 px-3 py-2 flex items-center gap-2">
          <span className="text-2xs text-slate-500 uppercase tracking-wider">Arrange</span>
          {onArrangeGrid && (
            <button
              className="w-7 h-7 flex items-center justify-center text-slate-400 hover:text-primary rounded hover:bg-white/5 transition-colors"
              onClick={onArrangeGrid}
              title="Tile selected in grid (or all if none selected)"
            >
              <span className="material-symbols-outlined text-base">grid_view</span>
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
      )}

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
          {getDimensionIcon(dragState.nodeType)} {dragState.label}
        </div>
      )}
    </div>
  )
}

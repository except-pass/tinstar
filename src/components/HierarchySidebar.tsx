import type { TreeNode, GroupingDimension } from '../domain/types'
import { useSelection } from './SelectionProvider'

interface HierarchySidebarProps {
  tree: TreeNode[]
  dimensions: GroupingDimension[]
  onAdd: (parentId: string | null, type: GroupingDimension | 'run') => void
  onFocusRun?: (runId: string) => void
}

const ICONS: Record<GroupingDimension | 'run', string> = {
  initiative: '🚀',
  epic: '📦',
  task: '✅',
  worktree: '🌿',
  run: '▶',
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
  onFocusRun,
}: {
  node: TreeNode
  depth: number
  dimensions: GroupingDimension[]
  onAdd: HierarchySidebarProps['onAdd']
  onFocusRun?: (runId: string) => void
}) {
  const { isSelected, isExpanded, isHovered, select, hover, toggleExpand } = useSelection()

  const selected = isSelected(node.id)
  const expanded = isExpanded(node.id)
  const hovered = isHovered(node.id)
  const hasChildren = node.children.length > 0
  const isRun = node.type === 'run'

  return (
    <div>
      <div
        className={[
          'group flex items-center gap-1 px-2 py-1 cursor-pointer text-xs',
          'hover:bg-surface-hover transition-colors',
          selected ? 'bg-primary/20 text-primary neon-border' : '',
          hovered ? 'bg-surface-hover' : '',
        ].join(' ')}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        data-testid={`sidebar-node-${node.id}`}
        onClick={() => {
          select(node.id, node.type)
          if (hasChildren) toggleExpand(node.id)
        }}
        onDoubleClick={() => {
          if (node.type === 'run' && onFocusRun) {
            onFocusRun(node.entityId)
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
          {ICONS[node.type]}
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

        {/* Label */}
        <span className="truncate flex-1">{node.label}</span>

        {/* Count badge */}
        {!isRun && node.runCount > 0 && (
          <span className="text-2xs bg-surface-raised px-1.5 py-0.5 rounded-full text-slate-400">
            {node.runCount}
          </span>
        )}

        {/* Add button */}
        {!isRun && (
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
              onFocusRun={onFocusRun}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function HierarchySidebar({ tree, dimensions, onAdd, onFocusRun }: HierarchySidebarProps) {
  const rootType = dimensions[0] ?? 'initiative'
  return (
    <div className="flex flex-col h-full" data-testid="hierarchy-sidebar">
      {/* Header */}
      <div className="panel-header px-3 py-2 flex items-center justify-between">
        <span className="panel-label text-xs font-display uppercase tracking-wider">
          Hierarchy
        </span>
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
      <div className="flex-1 overflow-y-auto scrollbar-thin py-1">
        {tree.length === 0 ? (
          <div className="px-3 py-4 text-xs text-slate-500 text-center">
            No items. Click + to create.
          </div>
        ) : (
          tree.map(node => (
            <SidebarNode
              key={node.id}
              node={node}
              depth={0}
              dimensions={dimensions}
              onAdd={onAdd}
              onFocusRun={onFocusRun}
            />
          ))
        )}
      </div>
    </div>
  )
}

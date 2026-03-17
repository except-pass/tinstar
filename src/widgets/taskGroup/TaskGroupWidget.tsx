import { useCallback } from 'react'
import type { WidgetProps, GroupWidgetData } from '../widgetComponentRegistry'
import { getDimensionIcon } from '../../domain/dimension-meta'
import type { GroupingDimension } from '../../domain/types'

const BORDER_OPACITY = [0.15, 0.12, 0.08, 0.05]
const BG_OPACITY = [0.02, 0.015, 0.01, 0.005]

export function TaskGroupWidget({ data, isDropTarget }: WidgetProps) {
  const { node, depth, onShrinkToFit, onDelete, onMenuOpen } =
    data as GroupWidgetData

  const borderOp =
    BORDER_OPACITY[Math.min(depth, BORDER_OPACITY.length - 1)] ?? 0.05
  const bgOp = BG_OPACITY[Math.min(depth, BG_OPACITY.length - 1)] ?? 0.005
  const icon = getDimensionIcon(node.type as GroupingDimension)

  const handleDoubleClick = useCallback(() => {
    onShrinkToFit?.(node.id)
  }, [node.id, onShrinkToFit])

  return (
    <div
      data-testid={`group-container-${node.id}`}
      className={`w-full h-full ${depth === 0 ? 'rounded-lg' : 'rounded-md'}`}
      onDoubleClick={handleDoubleClick}
      style={{
        border: isDropTarget
          ? '2px solid rgba(0, 240, 255, 0.6)'
          : `1px solid rgba(0, 240, 255, ${borderOp})`,
        background: isDropTarget
          ? 'rgba(0, 240, 255, 0.08)'
          : `rgba(0, 240, 255, ${bgOp})`,
        boxShadow: isDropTarget
          ? '0 0 20px rgba(0, 240, 255, 0.15), inset 0 0 20px rgba(0, 240, 255, 0.05)'
          : 'none',
        transition: 'border 150ms, background 150ms, box-shadow 150ms',
      }}
    >
      {/* Header — drag handle for the shell */}
      <div
        className="widget-drag-handle group/header h-8 flex items-center px-3 cursor-grab active:cursor-grabbing select-none"
        style={{
          borderBottom: `1px solid rgba(0, 240, 255, ${borderOp * 0.5})`,
        }}
        onDragStart={(e) => e.preventDefault()}
      >
        <span className="text-xs font-display uppercase tracking-wider text-primary/50 flex-1">
          {icon} {node.label}
        </span>
        {onMenuOpen && (
          <button
            className="w-5 h-5 flex items-center justify-center text-slate-500 hover:text-primary opacity-0 group-hover/header:opacity-100 transition-opacity cursor-pointer"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              onMenuOpen(node.id, rect)
            }}
            data-testid={`menu-group-${node.id}`}
            aria-label={`Menu for ${node.label}`}
          >
            ⋮
          </button>
        )}
        {onDelete && !onMenuOpen && (
          <button
            className="w-5 h-5 flex items-center justify-center text-slate-500 hover:text-red-400 opacity-0 group-hover/header:opacity-100 transition-opacity cursor-pointer"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => onDelete(node.id)}
            data-testid={`delete-group-${node.id}`}
            aria-label={`Delete ${node.label}`}
          >
            ×
          </button>
        )}
      </div>
    </div>
  )
}

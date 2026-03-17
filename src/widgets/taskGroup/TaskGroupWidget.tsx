import { useCallback, useState } from 'react'
import type { WidgetProps, GroupWidgetData } from '../widgetComponentRegistry'
import { getDimensionIcon } from '../../domain/dimension-meta'
import type { GroupingDimension } from '../../domain/types'
import { hexToRgba } from '../../components/runAccent'

const BORDER_OPACITY = [0.15, 0.12, 0.08, 0.05]
const BG_OPACITY = [0.02, 0.015, 0.01, 0.005]

/** Produce a short readable label from a URL (e.g. Jira issue key, GitHub #N, or hostname) */
function urlLabel(url: string): string {
  try {
    const parsed = new URL(url)
    // Jira: /browse/PROJ-123
    const jira = parsed.pathname.match(/\/browse\/([A-Z]+-\d+)/)
    if (jira) return jira[1]!
    // GitHub issue/PR: /owner/repo/issues/123 or /pulls/123
    const gh = parsed.pathname.match(/\/(issues|pull)\/(\d+)/)
    if (gh) return `#${gh[2]}`
    return parsed.hostname
  } catch {
    return url
  }
}

export function TaskGroupWidget({ data, isSelected, isDropTarget }: WidgetProps) {
  const { node, depth, onShrinkToFit, onDelete, onMenuOpen, onTaskUpdate } =
    data as GroupWidgetData
  const [editingUrl, setEditingUrl] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')

  const borderOp =
    BORDER_OPACITY[Math.min(depth, BORDER_OPACITY.length - 1)] ?? 0.05
  const bgOp = BG_OPACITY[Math.min(depth, BG_OPACITY.length - 1)] ?? 0.005
  const icon = getDimensionIcon(node.type as GroupingDimension)
  const accent = node.color || '#00f0ff'

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
          ? `2px solid ${hexToRgba(accent, 0.6)}`
          : isSelected
            ? `1px solid ${hexToRgba(accent, 0.5)}`
            : `1px solid ${hexToRgba(accent, borderOp)}`,
        background: isDropTarget
          ? hexToRgba(accent, 0.08)
          : isSelected
            ? hexToRgba(accent, 0.06)
            : hexToRgba(accent, bgOp),
        boxShadow: isDropTarget
          ? `0 0 20px ${hexToRgba(accent, 0.15)}, inset 0 0 20px ${hexToRgba(accent, 0.05)}`
          : isSelected
            ? `0 0 0 1px ${hexToRgba(accent, 0.2)}, 0 0 12px ${hexToRgba(accent, 0.1)}`
            : 'none',
        transition: 'border 150ms, background 150ms, box-shadow 150ms',
      }}
    >
      {/* Header — drag handle for the shell */}
      <div
        className="widget-drag-handle group/header h-8 flex items-center px-3 cursor-grab active:cursor-grabbing select-none"
        style={{
          borderBottom: `1px solid ${hexToRgba(accent, borderOp * 0.5)}`,
        }}
        onDragStart={(e) => e.preventDefault()}
      >
        <span className="text-xs font-display uppercase tracking-wider flex-1" style={{ color: hexToRgba(accent, 0.7) }}>
          {icon} {node.label}
        </span>
        {/* External link badge — task nodes only */}
        {node.type === 'task' && (
          editingUrl ? (
            <input
              autoFocus
              className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-primary/30 bg-primary/5 text-primary/80 outline-none w-32"
              placeholder="https://..."
              value={urlDraft}
              onPointerDown={(e) => e.stopPropagation()}
              onChange={(e) => setUrlDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  onTaskUpdate?.(node.entityId, { externalUrl: urlDraft.trim() || null })
                  setEditingUrl(false)
                } else if (e.key === 'Escape') {
                  setEditingUrl(false)
                }
              }}
              onBlur={() => {
                onTaskUpdate?.(node.entityId, { externalUrl: urlDraft.trim() || null })
                setEditingUrl(false)
              }}
            />
          ) : node.externalUrl ? (
            <a
              href={node.externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-primary/25 bg-primary/6 text-primary/60 hover:text-primary hover:border-primary/50 transition-colors cursor-pointer"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              onDoubleClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setUrlDraft(node.externalUrl ?? '')
                setEditingUrl(true)
              }}
              title={node.externalUrl}
            >
              ↗ {urlLabel(node.externalUrl)}
            </a>
          ) : (
            <button
              className="text-[9px] font-mono px-1 py-0.5 rounded text-slate-600 hover:text-primary/50 opacity-0 group-hover/header:opacity-100 transition-opacity cursor-pointer"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                setUrlDraft('')
                setEditingUrl(true)
              }}
              title="Add external link"
            >
              + link
            </button>
          )
        )}
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

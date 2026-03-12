import { useEffect, useRef, useState, useCallback } from 'react'
import type { GroupingDimension } from '../domain/types'

export interface EntityMenuProps {
  entityId: string
  entityType: GroupingDimension
  entityName: string
  anchorRect: DOMRect
  onStartSession: () => void
  onSettings: () => void
  onRename: () => void
  onAddChild: () => void
  onDelete: () => void
  onClose: () => void
}

export function EntityMenu({
  entityType,
  entityName,
  anchorRect,
  onStartSession,
  onSettings,
  onRename,
  onAddChild,
  onDelete,
  onClose,
}: EntityMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Close on click-outside or Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKey)
    document.addEventListener('pointerdown', handleClick)
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.removeEventListener('pointerdown', handleClick)
    }
  }, [onClose])

  const isWorktree = entityType === 'worktree'

  // Position menu below anchor, aligned to left
  const top = anchorRect.bottom + 4
  const left = anchorRect.left

  const menuItem = useCallback(
    (label: string, icon: string, onClick: () => void, className = '') => (
      <button
        className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-surface-hover transition-colors ${className}`}
        onClick={() => {
          onClick()
          onClose()
        }}
        data-testid={`menu-action-${label.toLowerCase().replace(/\W+/g, '-')}`}
      >
        <span className="material-symbols-outlined text-sm" style={{ fontSize: '16px' }}>
          {icon}
        </span>
        {label}
      </button>
    ),
    [onClose],
  )

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] bg-surface-panel border border-primary/20 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ top, left }}
      data-testid="entity-menu"
    >
      {!isWorktree && menuItem('Start Session', 'play_arrow', onStartSession, 'text-blue-400')}
      {!isWorktree && menuItem('Settings...', 'settings', onSettings)}
      {menuItem('Rename', 'edit', onRename)}
      {menuItem('Add Child', 'add', onAddChild)}

      <div className="border-t border-white/10 my-1" />

      {confirmDelete ? (
        <div className="px-3 py-2 text-xs">
          <p className="text-slate-400 mb-2">
            Delete <span className="text-slate-200">{entityName}</span>? Children will be ungrouped.
          </p>
          <div className="flex gap-2">
            <button
              className="px-2 py-1 bg-red-500/20 text-red-400 rounded text-xs hover:bg-red-500/30"
              data-testid="menu-confirm-delete"
              onClick={() => {
                onDelete()
                onClose()
              }}
            >
              Delete
            </button>
            <button
              className="px-2 py-1 bg-surface-raised text-slate-400 rounded text-xs hover:bg-surface-hover"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left hover:bg-surface-hover transition-colors text-red-400"
          onClick={() => setConfirmDelete(true)}
          data-testid="menu-action-delete"
        >
          <span className="material-symbols-outlined text-sm" style={{ fontSize: '16px' }}>
            close
          </span>
          Delete
        </button>
      )}
    </div>
  )
}

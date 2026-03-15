import { useState, useRef, useEffect, useCallback } from 'react'
import type { GroupingDimension } from '../domain/types'
import { getDimensionLabel } from '../domain/dimension-meta'

export interface CreateDialogState {
  parentId: string | null
  parentType: GroupingDimension | null
  childType: GroupingDimension
}

interface Props {
  dialog: CreateDialogState
  onClose: () => void
  onOptimisticCreate?: (entity: string, data: unknown) => void
}

const ENDPOINT_MAP: Record<string, string> = {
  initiative: '/api/initiatives',
  epic: '/api/epics',
  task: '/api/tasks',
  worktree: '/api/worktrees',
}

const ID_PREFIX_MAP: Record<string, string> = {
  initiative: 'init',
  epic: 'epic',
  task: 'task',
  worktree: 'wt',
}

// Map parent dimension to the foreign key field name on the child
function parentKeyField(parentType: GroupingDimension | null): string | null {
  if (!parentType) return null
  return `${parentType}Id`
}

export function CreateEntityDialog({ dialog, onClose, onOptimisticCreate }: Props) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#00f0ff')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = useCallback(() => {
    const trimmedName = name.trim()
    if (!trimmedName) return

    const endpoint = ENDPOINT_MAP[dialog.childType]
    if (!endpoint) return

    const prefix = ID_PREFIX_MAP[dialog.childType] ?? dialog.childType
    const id = `${prefix}-${crypto.randomUUID().slice(0, 8)}`

    const body: Record<string, string> = { name: trimmedName, id }

    // Set parent foreign key
    const fkField = parentKeyField(dialog.parentType)
    if (fkField && dialog.parentId) {
      body[fkField] = dialog.parentId
    }

    // For initiatives, include color
    if (dialog.childType === 'initiative') {
      body.color = color
    }

    // Inject optimistic entity immediately
    if (onOptimisticCreate) {
      const optimistic: Record<string, unknown> = {
        id,
        name: trimmedName,
        status: 'active',
        summary: '',
        ...(fkField && dialog.parentId ? { [fkField]: dialog.parentId } : {}),
      }
      if (dialog.childType === 'initiative') optimistic.color = color
      if (dialog.childType === 'epic' && !optimistic.initiativeId) optimistic.initiativeId = ''
      if (dialog.childType === 'task') {
        if (!optimistic.epicId) optimistic.epicId = ''
        if (!optimistic.initiativeId) optimistic.initiativeId = ''
      }
      onOptimisticCreate(dialog.childType, optimistic)
    }

    onClose()

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }, [name, color, dialog, onClose, onOptimisticCreate])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit()
    if (e.key === 'Escape') onClose()
  }, [handleSubmit, onClose])

  const label = getDimensionLabel(dialog.childType)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
      data-testid="create-dialog-backdrop"
    >
      <div
        className="bg-surface-panel border border-white/10 rounded-lg p-4 w-80 shadow-xl"
        onClick={e => e.stopPropagation()}
        data-testid="create-dialog"
      >
        <h3 className="text-sm font-display uppercase tracking-wider text-primary mb-3">
          New {label}
        </h3>

        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`${label} name`}
          className="w-full px-3 py-2 bg-surface-base border border-white/10 rounded text-sm text-slate-200 placeholder:text-slate-500 focus:border-primary/50 focus:outline-none"
          data-testid="create-dialog-name"
        />

        {dialog.childType === 'initiative' && (
          <div className="flex items-center gap-2 mt-3">
            <label className="text-xs text-slate-400">Color</label>
            <input
              type="color"
              value={color}
              onChange={e => setColor(e.target.value)}
              className="w-8 h-6 bg-transparent border border-white/10 rounded cursor-pointer"
            />
          </div>
        )}

        <div className="flex justify-end gap-2 mt-4">
          <button
            className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 text-xs bg-primary/20 text-primary border border-primary/40 rounded hover:bg-primary/30 disabled:opacity-50"
            onClick={handleSubmit}
            disabled={!name.trim()}
            data-testid="create-dialog-submit"
          >
            Create
          </button>
        </div>
      </div>
    </div>
  )
}

import { useState, useRef, useEffect, useCallback } from 'react'
import type { GroupingDimension } from '../domain/types'
import { useDimensionMeta } from '../hooks/useDimensionMeta'
import { randomUUID } from '../uuid'
import { PATTERNS, type PatternType } from '../domain/patterns'
import { PatternPreview } from './PatternPreview'

export interface CreateDialogState {
  parentId: string | null
  parentType: GroupingDimension | null
  childType: GroupingDimension
}

interface Props {
  dialog: CreateDialogState
  onClose: () => void
  onOptimisticCreate?: (entity: string, data: unknown) => void
  onCreated?: (entityId: string, entityType: GroupingDimension, entityName: string) => void
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

export function CreateEntityDialog({ dialog, onClose, onOptimisticCreate, onCreated }: Props) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#00f0ff')
  const [pattern, setPattern] = useState<PatternType>('single')
  const [showPreview, setShowPreview] = useState(false)
  const isTask = dialog.childType === 'task'
  const inputRef = useRef<HTMLInputElement>(null)
  const levelMeta = useDimensionMeta()

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSubmit = useCallback(() => {
    const trimmedName = name.trim()
    if (!trimmedName) return

    const endpoint = ENDPOINT_MAP[dialog.childType]
    if (!endpoint) return

    const prefix = ID_PREFIX_MAP[dialog.childType] ?? dialog.childType
    const id = `${prefix}-${randomUUID().slice(0, 8)}`

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

    // For tasks, include pattern if not single
    if (dialog.childType === 'task' && pattern !== 'single') {
      body.pattern = pattern
    }

    // Inject optimistic entity immediately
    if (onOptimisticCreate) {
      const optimistic: Record<string, unknown> = {
        id,
        name: trimmedName,
        status: 'active',
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
    onCreated?.(id, dialog.childType, trimmedName)

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }, [name, color, pattern, dialog, onClose, onOptimisticCreate, onCreated])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit()
    if (e.key === 'Escape') onClose()
  }, [handleSubmit, onClose])

  const label = levelMeta.find(m => m.internalType === dialog.childType)?.label ?? dialog.childType

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

        {isTask && (
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-400">Pattern</label>
              <button
                type="button"
                onClick={() => setShowPreview(!showPreview)}
                className="text-2xs text-slate-500 hover:text-slate-300"
              >
                {showPreview ? 'hide' : '? preview'}
              </button>
            </div>
            <select
              value={pattern}
              onChange={e => setPattern(e.target.value as PatternType)}
              className="w-full mt-1 px-3 py-2 bg-surface-base border border-white/10 rounded text-sm text-slate-200 focus:border-primary/50 focus:outline-none"
            >
              {Object.values(PATTERNS).map(p => (
                <option key={p.type} value={p.type}>
                  {p.label}
                </option>
              ))}
            </select>
            {showPreview && <PatternPreview pattern={pattern} />}
          </div>
        )}

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

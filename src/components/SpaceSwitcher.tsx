import { useState, useRef, useEffect, useCallback } from 'react'
import type { Space } from '../domain/types'

interface Props {
  spaces: Space[]
  activeSpaceId: string
  onActivate: (id: string) => void
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}

export function SpaceSwitcher({ spaces, activeSpaceId, onActivate, onCreate, onRename, onDelete }: Props) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const popoverRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const renameRef = useRef<HTMLInputElement>(null)

  const activeSpace = spaces.find(s => s.id === activeSpaceId)

  // Close popover on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
        setContextMenu(null)
      }
    }
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [open])

  // Auto-focus create input
  useEffect(() => {
    if (creating && inputRef.current) inputRef.current.focus()
  }, [creating])

  // Auto-focus rename input
  useEffect(() => {
    if (renaming && renameRef.current) renameRef.current.focus()
  }, [renaming])

  const handleCreate = useCallback(() => {
    const trimmed = newName.trim()
    if (!trimmed) return
    onCreate(trimmed)
    setNewName('')
    setCreating(false)
  }, [newName, onCreate])

  const handleRename = useCallback(() => {
    const trimmed = renameValue.trim()
    if (!trimmed || !renaming) return
    onRename(renaming, trimmed)
    setRenaming(null)
    setRenameValue('')
  }, [renameValue, renaming, onRename])

  const handleDelete = useCallback((id: string) => {
    if (id === activeSpaceId) return
    if (spaces.length <= 1) return
    onDelete(id)
    setContextMenu(null)
  }, [activeSpaceId, spaces.length, onDelete])

  return (
    <div className="relative" ref={popoverRef}>
      {/* Trigger */}
      <button
        className="panel-header px-3 py-2 flex items-center justify-between w-full hover:bg-surface-hover transition-colors"
        onClick={() => setOpen(!open)}
        data-testid="space-switcher"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="material-symbols-outlined text-primary text-sm">folder_open</span>
          <span className="panel-label text-xs font-display uppercase tracking-wider truncate">
            {activeSpace?.name ?? 'No Space'}
          </span>
        </div>
        <span className="material-symbols-outlined text-slate-500 text-xs">
          {open ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {/* Popover */}
      {open && (
        <div className="absolute top-full left-0 right-0 z-50 bg-surface-raised border border-primary/25 shadow-neon mt-0.5">
          {/* Space list */}
          <div className="max-h-60 overflow-y-auto scrollbar-thin">
            {spaces.map(space => (
              <div
                key={space.id}
                className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-xs hover:bg-surface-hover transition-colors ${
                  space.id === activeSpaceId ? 'text-primary' : 'text-slate-400'
                }`}
                onClick={() => {
                  if (space.id !== activeSpaceId) onActivate(space.id)
                  setOpen(false)
                }}
                onContextMenu={e => {
                  e.preventDefault()
                  setContextMenu({ id: space.id, x: e.clientX, y: e.clientY })
                }}
              >
                {renaming === space.id ? (
                  <input
                    ref={renameRef}
                    className="flex-1 bg-transparent border-b border-primary/50 outline-none text-xs font-mono text-primary"
                    value={renameValue}
                    onChange={e => setRenameValue(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleRename()
                      if (e.key === 'Escape') { setRenaming(null); setRenameValue('') }
                    }}
                    onBlur={handleRename}
                    onClick={e => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className={`w-1.5 h-1.5 rounded-full ${space.id === activeSpaceId ? 'bg-primary shadow-[0_0_4px_#00f0ff]' : 'bg-slate-600'}`} />
                    <span className="font-mono truncate flex-1">{space.name}</span>
                    {space.id === activeSpaceId && (
                      <span className="material-symbols-outlined text-primary text-xs">check</span>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Divider + create */}
          <div className="border-t border-primary/15 px-3 py-1.5">
            {creating ? (
              <input
                ref={inputRef}
                className="w-full bg-transparent border-b border-primary/50 outline-none text-xs font-mono text-primary placeholder-slate-600"
                placeholder="Space name..."
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleCreate()
                  if (e.key === 'Escape') { setCreating(false); setNewName('') }
                }}
                onBlur={() => { if (!newName.trim()) setCreating(false) }}
              />
            ) : (
              <button
                className="flex items-center gap-2 text-xs text-slate-500 hover:text-primary transition-colors w-full"
                onClick={() => setCreating(true)}
                data-testid="create-space-btn"
              >
                <span className="material-symbols-outlined text-xs">add</span>
                New Space
              </button>
            )}
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-[100] bg-surface-raised border border-primary/25 shadow-neon py-1 min-w-[120px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            className="w-full text-left px-3 py-1 text-xs text-slate-300 hover:bg-surface-hover hover:text-primary transition-colors"
            onClick={() => {
              const space = spaces.find(s => s.id === contextMenu.id)
              if (space) {
                setRenaming(space.id)
                setRenameValue(space.name)
              }
              setContextMenu(null)
            }}
          >
            Rename
          </button>
          <button
            className={`w-full text-left px-3 py-1 text-xs transition-colors ${
              contextMenu.id === activeSpaceId || spaces.length <= 1
                ? 'text-slate-600 cursor-not-allowed'
                : 'text-slate-300 hover:bg-surface-hover hover:text-accent-red'
            }`}
            onClick={() => handleDelete(contextMenu.id)}
            disabled={contextMenu.id === activeSpaceId || spaces.length <= 1}
          >
            Delete{contextMenu.id === activeSpaceId ? ' (active)' : ''}
          </button>
        </div>
      )}
    </div>
  )
}

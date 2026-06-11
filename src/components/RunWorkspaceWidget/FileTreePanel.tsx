import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch } from '../../apiClient'
import { useConfig } from '../../context/ConfigContext'
import { FileUploadConfirmModal, type PendingUpload } from './FileUploadConfirmModal'
import { useFileUpload } from './useFileUpload'

interface FileEntry {
  name: string
  path: string
  isDir: boolean
  uploading?: boolean
  progress?: number   // 0..1
  uploadError?: string
}

interface TreeNodeState {
  entries: FileEntry[] | null
  open: boolean
  loading: boolean
}

interface Props {
  sessionId: string
  onOpenFile?: (filePath: string) => void
  onCollapse?: () => void
}

/** Lazy-loading file tree panel — fetches one directory level at a time */
export function FileTreePanel({ sessionId, onOpenFile }: Props) {
  const [dirs, setDirs] = useState<Map<string, TreeNodeState>>(() => new Map())
  const [pending, setPending] = useState<{ files: File[]; dir: string } | null>(null)
  const [hoverDir, setHoverDir] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; value: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // Set when Enter/Escape already resolved a rename, so the input's onBlur
  // (fired as it unmounts) doesn't submit a second time.
  const renameResolvedRef = useRef(false)
  const config = useConfig()
  const maxBytes = config?.uploadMaxBytes ?? 100 * 1024 * 1024
  const { start: startUpload } = useFileUpload()

  const loadDir = useCallback(async (dirPath: string) => {
    setDirs(prev => {
      const next = new Map(prev)
      next.set(dirPath, { entries: prev.get(dirPath)?.entries ?? null, open: true, loading: true })
      return next
    })
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}/files?path=${encodeURIComponent(dirPath)}`)
      const data = await res.json()
      if (data.ok) {
        setDirs(prev => {
          const next = new Map(prev)
          next.set(dirPath, { entries: data.data, open: true, loading: false })
          return next
        })
      }
    } catch {
      setDirs(prev => {
        const next = new Map(prev)
        next.set(dirPath, { entries: [], open: true, loading: false })
        return next
      })
    }
  }, [sessionId])

  // Load root on mount
  useEffect(() => { loadDir('.') }, [loadDir])

  const toggleDir = useCallback((dirPath: string) => {
    setDirs(prev => {
      const existing = prev.get(dirPath)
      if (!existing?.entries) return prev // not loaded — loadDir will be called instead
      const next = new Map(prev)
      next.set(dirPath, { ...existing, open: !existing.open })
      return next
    })
  }, [])

  const handleDragStart = useCallback((e: React.DragEvent, filePath: string) => {
    e.dataTransfer.setData('text/plain', filePath)
    e.dataTransfer.setData('application/tinstar-editor', JSON.stringify({ sessionId, filePath }))
    e.dataTransfer.effectAllowed = 'copy'
  }, [sessionId])

  function isFilesDrag(e: React.DragEvent): boolean {
    return Array.from(e.dataTransfer.types).includes('Files')
  }

  function dirnameRel(p: string): string {
    if (!p.includes('/')) return '.'
    return p.slice(0, p.lastIndexOf('/'))
  }

  const handleRowDragOver = useCallback((e: React.DragEvent, rowPath: string, isDir: boolean) => {
    if (!isFilesDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setHoverDir(isDir ? rowPath : dirnameRel(rowPath))
  }, [])

  const handlePanelDragOver = useCallback((e: React.DragEvent) => {
    if (!isFilesDrag(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (hoverDir === null) setHoverDir('.')
  }, [hoverDir])

  const handleDragLeavePanel = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) setHoverDir(null)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!isFilesDrag(e)) return
    e.preventDefault()
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    const dir = hoverDir ?? '.'
    setPending({ files, dir })
    setHoverDir(null)
  }, [hoverDir])

  const existingPaths = useMemo(() => {
    const set = new Set<string>()
    for (const node of dirs.values()) {
      if (!node.entries) continue
      for (const e of node.entries) set.add(e.path)
    }
    return set
  }, [dirs])

  const handleConfirm = useCallback((rows: PendingUpload[]) => {
    setPending(null)
    for (const row of rows) {
      const dir = dirnameRel(row.path)
      const name = row.path.slice(row.path.lastIndexOf('/') + 1)
      const optimistic: FileEntry = { name, path: row.path, isDir: false, uploading: true, progress: 0 }

      setDirs(prev => {
        const next = new Map(prev)
        const node = next.get(dir)
        if (!node?.entries) return prev
        const filtered = node.entries.filter(e => e.path !== row.path)
        next.set(dir, { ...node, entries: [...filtered, optimistic].sort(sortEntries) })
        return next
      })

      const handle = startUpload({
        sessionId,
        file: row.file,
        path: row.path,
        onProgress: (frac) => {
          setDirs(prev => {
            const next = new Map(prev)
            const node = next.get(dir)
            if (!node?.entries) return prev
            next.set(dir, {
              ...node,
              entries: node.entries.map(e => e.path === row.path ? { ...e, progress: frac } : e),
            })
            return next
          })
        },
      })

      handle.promise.then(() => {
        loadDir(dir)
      }).catch((err: { code?: string; message?: string }) => {
        setDirs(prev => {
          const next = new Map(prev)
          const node = next.get(dir)
          if (!node?.entries) return prev
          next.set(dir, {
            ...node,
            entries: node.entries.map(e => e.path === row.path
              ? { ...e, uploading: false, uploadError: err?.message || err?.code || 'Upload failed' }
              : e),
          })
          return next
        })
      })
    }
  }, [sessionId, loadDir, startUpload])

  const openMenu = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault()
    e.stopPropagation()
    setActionError(null)
    setMenu({ x: e.clientX, y: e.clientY, entry })
  }, [])

  const downloadFile = useCallback(async (entry: FileEntry) => {
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}/files/download?path=${encodeURIComponent(entry.path)}`)
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = entry.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      setActionError((err as Error).message || 'Download failed')
    }
  }, [sessionId])

  const commitRename = useCallback(async (entry: FileEntry, rawName: string) => {
    const name = rawName.trim()
    setRenaming(null)
    if (!name || name === entry.name) return
    if (name.includes('/')) { setActionError('Name cannot contain "/"'); return }
    const dir = dirnameRel(entry.path)
    const to = dir === '.' ? name : `${dir}/${name}`
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}/files/rename`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: entry.path, to }),
      })
      const data = await res.json()
      if (data.ok) loadDir(dir)
      else setActionError(data.error?.message || 'Rename failed')
    } catch (err) {
      setActionError((err as Error).message || 'Rename failed')
    }
  }, [sessionId, loadDir])

  // Dismiss the context menu on Escape or any outside click.
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  function renderRenameInput(entry: FileEntry): React.ReactNode {
    return (
      <input
        autoFocus
        value={renaming?.value ?? entry.name}
        onChange={(e) => setRenaming({ path: entry.path, value: e.target.value })}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') { renameResolvedRef.current = true; commitRename(entry, (e.target as HTMLInputElement).value) }
          else if (e.key === 'Escape') { renameResolvedRef.current = true; setRenaming(null) }
        }}
        onBlur={(e) => {
          if (renameResolvedRef.current) { renameResolvedRef.current = false; return }
          commitRename(entry, e.target.value)
        }}
        className="text-[11px] font-mono bg-surface-2 text-slate-100 px-1 rounded outline outline-1 outline-primary/60 min-w-0 flex-1"
        spellCheck={false}
      />
    )
  }

  function renderEntries(dirPath: string, depth: number): React.ReactNode {
    const state = dirs.get(dirPath)
    if (!state || !state.open) return null
    if (state.loading && !state.entries) {
      return (
        <div className="flex items-center gap-1 text-2xs text-slate-600 font-mono py-0.5" style={{ paddingLeft: depth * 14 + 12 }}>
          <span className="animate-pulse">loading...</span>
        </div>
      )
    }
    if (!state.entries?.length) return null

    return state.entries.map(entry => (
      <div key={entry.path}>
        {entry.isDir ? (
          <>
            <button
              onClick={() => {
                const existing = dirs.get(entry.path)
                if (!existing?.entries) loadDir(entry.path)
                else toggleDir(entry.path)
              }}
              className={`w-full flex items-center gap-1 py-[2px] text-left group ${
                hoverDir === entry.path ? 'outline outline-1 outline-primary/60 bg-primary/10' : 'hover:bg-surface-hover'
              }`}
              style={{ paddingLeft: depth * 14 + 4 }}
              onContextMenu={(e) => openMenu(e, entry)}
              onDragOver={(e) => handleRowDragOver(e, entry.path, true)}
              onDrop={handleDrop}
            >
              <span className="material-symbols-outlined text-xs text-slate-500 w-4 text-center">
                {dirs.get(entry.path)?.open ? 'expand_more' : 'chevron_right'}
              </span>
              <span className="material-symbols-outlined text-sm text-primary/40 group-hover:text-primary/60">folder</span>
              {renaming?.path === entry.path
                ? renderRenameInput(entry)
                : <span className="text-[11px] font-mono text-slate-300 truncate">{entry.name}</span>}
            </button>
            {renderEntries(entry.path, depth + 1)}
          </>
        ) : (
          <div
            draggable={!entry.uploading}
            onDragStart={(e) => { if (entry.uploading) return; e.stopPropagation(); handleDragStart(e, entry.path) }}
            onDragOver={(e) => handleRowDragOver(e, entry.path, false)}
            onDrop={handleDrop}
            onDoubleClick={(e) => { e.stopPropagation(); onOpenFile?.(entry.path) }}
            onContextMenu={(e) => openMenu(e, entry)}
            onPointerDown={(e) => { if (e.button === 0) e.stopPropagation() }}
            className={`flex items-center gap-1 py-[2px] cursor-grab active:cursor-grabbing group relative ${
              hoverDir === dirnameRel(entry.path) ? 'outline outline-1 outline-primary/60 bg-primary/5' : 'hover:bg-surface-hover'
            } ${entry.uploadError ? 'bg-red-500/10' : ''}`}
            style={{
              paddingLeft: depth * 14 + 22,
              background: entry.uploading && entry.progress !== undefined
                ? `linear-gradient(to right, rgb(var(--color-primary) / 0.18) ${entry.progress * 100}%, transparent ${entry.progress * 100}%)`
                : undefined,
            }}
            title={entry.uploadError ? entry.uploadError : `Double-click to open · Drag to terminal`}
          >
            <span className="material-symbols-outlined text-sm text-slate-600 group-hover:text-slate-400">
              {entry.uploadError ? 'error' : fileIcon(entry.name)}
            </span>
            {renaming?.path === entry.path
              ? renderRenameInput(entry)
              : (
                <span className={`text-[11px] font-mono truncate ${entry.uploadError ? 'text-red-300' : 'text-slate-400 group-hover:text-slate-200'}`}>
                  {entry.name}
                </span>
              )}
          </div>
        )}
      </div>
    ))
  }

  return (
    <div
      data-scrollable
      data-testid="file-tree-panel"
      className={`flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin py-1 ${hoverDir === '.' ? 'outline outline-1 outline-primary/40' : ''}`}
      onDragOver={handlePanelDragOver}
      onDragLeave={handleDragLeavePanel}
      onDrop={handleDrop}
    >
      {renderEntries('.', 0)}
      {menu && createPortal(
        <div
          data-testid="file-context-menu"
          className="fixed z-[1000] min-w-[150px] rounded-md border border-border bg-surface-2 py-1 shadow-xl text-[12px]"
          style={{
            left: Math.min(menu.x, window.innerWidth - 170),
            top: Math.min(menu.y, window.innerHeight - 120),
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          {!menu.entry.isDir && (
            <>
              <ContextMenuItem icon="open_in_new" label="Open" onClick={() => { onOpenFile?.(menu.entry.path); setMenu(null) }} />
              <ContextMenuItem icon="download" label="Download" onClick={() => { downloadFile(menu.entry); setMenu(null) }} />
            </>
          )}
          <ContextMenuItem
            icon="edit"
            label="Rename"
            onClick={() => { setRenaming({ path: menu.entry.path, value: menu.entry.name }); setMenu(null) }}
          />
        </div>,
        document.body,
      )}
      {actionError && createPortal(
        <button
          className="fixed bottom-3 left-1/2 -translate-x-1/2 z-[1000] max-w-[90%] truncate rounded-md bg-red-600/90 px-3 py-1.5 text-[11px] text-white shadow-lg"
          onClick={() => setActionError(null)}
          title="Click to dismiss"
        >
          {actionError}
        </button>,
        document.body,
      )}
      {pending && (
        <FileUploadConfirmModal
          files={pending.files}
          initialTargetDir={pending.dir}
          existingPaths={existingPaths}
          maxBytes={maxBytes}
          onConfirm={handleConfirm}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
}

function ContextMenuItem({ icon, label, onClick }: { icon: string; label: string; onClick: () => void }) {
  return (
    <button
      className="w-full flex items-center gap-2 px-3 py-1 text-left text-slate-200 hover:bg-primary/15"
      onClick={onClick}
    >
      <span className="material-symbols-outlined text-sm text-slate-400">{icon}</span>
      <span className="font-mono">{label}</span>
    </button>
  )
}

function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx': return 'code'
    case 'json': case 'yaml': case 'yml': case 'toml': return 'data_object'
    case 'md': case 'txt': case 'rst': return 'description'
    case 'css': case 'scss': case 'less': return 'palette'
    case 'html': return 'web'
    case 'png': case 'jpg': case 'jpeg': case 'svg': case 'gif': return 'image'
    case 'sh': case 'bash': case 'zsh': return 'terminal'
    default: return 'draft'
  }
}

function sortEntries(a: FileEntry, b: FileEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name)
}

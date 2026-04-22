import { useState, useCallback, useEffect } from 'react'

interface FileEntry {
  name: string
  path: string
  isDir: boolean
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

  const loadDir = useCallback(async (dirPath: string) => {
    setDirs(prev => {
      const next = new Map(prev)
      next.set(dirPath, { entries: prev.get(dirPath)?.entries ?? null, open: true, loading: true })
      return next
    })
    try {
      const res = await fetch(`/api/sessions/${sessionId}/files?path=${encodeURIComponent(dirPath)}`)
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
              className="w-full flex items-center gap-1 py-[2px] text-left hover:bg-surface-hover group"
              style={{ paddingLeft: depth * 14 + 4 }}
            >
              <span className="material-symbols-outlined text-xs text-slate-500 w-4 text-center">
                {dirs.get(entry.path)?.open ? 'expand_more' : 'chevron_right'}
              </span>
              <span className="material-symbols-outlined text-sm text-primary/40 group-hover:text-primary/60">folder</span>
              <span className="text-[11px] font-mono text-slate-300 truncate">{entry.name}</span>
            </button>
            {renderEntries(entry.path, depth + 1)}
          </>
        ) : (
          <div
            draggable
            onDragStart={(e) => { e.stopPropagation(); handleDragStart(e, entry.path) }}
            onDoubleClick={(e) => { e.stopPropagation(); onOpenFile?.(entry.path) }}
            onPointerDown={(e) => { if (e.button === 0) e.stopPropagation() }}
            className="flex items-center gap-1 py-[2px] hover:bg-surface-hover cursor-grab active:cursor-grabbing group"
            style={{ paddingLeft: depth * 14 + 22 }}
            title={`Double-click to open · Drag to terminal`}
          >
            <span className="material-symbols-outlined text-sm text-slate-600 group-hover:text-slate-400">
              {fileIcon(entry.name)}
            </span>
            <span className="text-[11px] font-mono text-slate-400 group-hover:text-slate-200 truncate">{entry.name}</span>
          </div>
        )}
      </div>
    ))
  }

  return (
    <div data-scrollable className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin py-1">
      {renderEntries('.', 0)}
    </div>
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

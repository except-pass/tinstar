import { useState, useRef, useCallback } from 'react'
import type { TouchedFile, FileKind } from '../../types'

const kindIcon: Record<FileKind, string> = {
  code: 'code',
  config: 'data_object',
  test: 'science',
  script: 'terminal',
  doc: 'description',
}

interface Props {
  files: TouchedFile[]
  onFileSelect?: (file: TouchedFile) => void
  onCollapse?: () => void
}

export function TouchedFilesPanel({ files, onFileSelect, onCollapse }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(files[2]?.id ?? null)
  const [width, setWidth] = useState(160) // w-40 = 10rem = 160px
  const dragRef = useRef<{ startX: number; startW: number } | null>(null)

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragRef.current = { startX: e.clientX, startW: width }
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
  }, [width])

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return
    const newW = Math.max(100, Math.min(400, dragRef.current.startW + (e.clientX - dragRef.current.startX)))
    setWidth(newW)
  }, [])

  const onResizePointerUp = useCallback(() => {
    dragRef.current = null
  }, [])

  // Only count reconciled files in header totals
  const reconciledFiles = files.filter(f => !f.pending)
  const totalAdded = reconciledFiles.reduce((s, f) => s + f.additions, 0)
  const totalRemoved = reconciledFiles.reduce((s, f) => s + f.deletions, 0)

  return (
    <section className="flex flex-col border-r border-primary/20 bg-surface-panel relative" style={{ width }}>
      {/* Header */}
      <div className="panel-header overflow-hidden">
        <h3 className="panel-label truncate shrink min-w-0">Touched_Files</h3>
        <div className="flex items-center gap-1.5 text-2xs font-mono shrink-0">
          {width > 120 && (
            <>
              <span className="text-accent-green">+{totalAdded}</span>
              <span className="text-accent-red">-{totalRemoved}</span>
            </>
          )}
          {onCollapse && (
            <button
              data-testid="collapse-files"
              onClick={onCollapse}
              className="text-slate-500 hover:text-primary ml-1"
            >
              <span className="material-symbols-outlined text-sm">chevron_left</span>
            </button>
          )}
        </div>
      </div>

      {/* File count */}
      <div className="px-3 py-1.5 border-b border-primary/10 bg-surface-base/50">
        <span className="text-2xs font-mono text-slate-500">{files.length} files modified</span>
      </div>

      {/* File list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {files.map((file) => {
          const isSelected = selectedId === file.id
          return (
            <button
              key={file.id}
              onClick={() => {
                setSelectedId(file.id)
                onFileSelect?.(file)
              }}
              className={`
                w-full flex items-center justify-between px-3 py-1.5 text-left transition-all
                border-l-2 group
                ${isSelected
                  ? 'border-l-primary bg-primary/10 border-b border-b-primary/15'
                  : 'border-l-transparent hover:bg-surface-hover hover:border-l-primary/30 border-b border-b-transparent'
                }
              `}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  className={`material-symbols-outlined text-sm ${isSelected ? 'text-primary' : 'text-slate-500 group-hover:text-primary/60'}`}
                >
                  {kindIcon[file.kind]}
                </span>
                <div className="min-w-0">
                  <div className={`text-[11px] font-mono truncate ${isSelected ? 'text-primary' : 'text-slate-200'}`}>
                    {file.name}
                  </div>
                  <div className={`text-2xs font-mono truncate ${isSelected ? 'text-primary/50' : 'text-slate-600'}`}>
                    {file.path}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-1 font-mono text-2xs shrink-0 ml-2">
                {file.pending ? (
                  <span className="text-slate-500">...</span>
                ) : file.additions === 0 && file.deletions === 0 ? (
                  <span className="cursor-default" title="File was read but not modified">&#128083;</span>
                ) : (
                  <>
                    <span className="text-accent-green">+{file.additions}</span>
                    {file.deletions > 0 && (
                      <span className="text-accent-red">-{file.deletions}</span>
                    )}
                  </>
                )}
              </div>
            </button>
          )
        })}
      </div>
      {/* Resize handle */}
      <div
        className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors z-10"
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
      />
    </section>
  )
}

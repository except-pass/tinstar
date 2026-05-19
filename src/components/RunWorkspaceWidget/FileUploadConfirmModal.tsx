import { useEffect, useState, useMemo } from 'react'
import { createPortal } from 'react-dom'

export interface PendingUpload {
  file: File
  path: string
}

interface Props {
  files: File[]
  initialTargetDir: string
  existingPaths: Set<string>
  maxBytes: number
  onConfirm: (rows: PendingUpload[]) => void
  onCancel: () => void
}

interface RowState { file: File; path: string }

export function FileUploadConfirmModal({ files, initialTargetDir, existingPaths, maxBytes, onConfirm, onCancel }: Props) {
  const [rows, setRows] = useState<RowState[]>(() =>
    files.map(f => ({ file: f, path: joinPath(initialTargetDir, f.name) }))
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const validations = useMemo(() => rows.map(r => ({
    tooLarge: r.file.size > maxBytes,
    invalid: !r.path.trim() || r.path.startsWith('/') || r.path.split('/').some(seg => seg === '..'),
    overwrite: existingPaths.has(r.path),
  })), [rows, maxBytes, existingPaths])

  const allValid = validations.every(v => !v.tooLarge && !v.invalid)
  const anyOverwrite = validations.some(v => v.overwrite)

  function updatePath(i: number, path: string) {
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, path } : r))
  }
  function removeRow(i: number) {
    setRows(prev => prev.filter((_, idx) => idx !== i))
  }

  if (rows.length === 0) {
    queueMicrotask(onCancel)
    return null
  }

  // Portal to document.body: InfiniteCanvas applies `transform: translate(...) scale(...)`
  // to widget containers, which makes `position: fixed` resolve against the transformed
  // ancestor instead of the viewport. Without the portal the modal renders displaced/scaled.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="bg-surface-panel border border-white/10 rounded-lg shadow-2xl w-[640px] max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-white/10">
          <h3 className="text-sm font-mono text-slate-200">
            Upload {rows.length} file{rows.length === 1 ? '' : 's'}
          </h3>
          <p className="text-2xs text-slate-500 mt-0.5">Target paths are workspace-relative. Edit before confirming.</p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3 space-y-2">
          {rows.map((r, i) => {
            const v = validations[i]
            return (
              <div key={i} className="flex items-center gap-2">
                <span className="material-symbols-outlined text-sm text-slate-500">draft</span>
                <input
                  type="text"
                  value={r.path}
                  onChange={e => updatePath(i, e.target.value)}
                  className={`flex-1 text-xs font-mono bg-surface-base border rounded px-2 py-1 text-slate-200 focus:outline-none focus:border-primary/60 ${
                    v.invalid || v.tooLarge ? 'border-red-500/60' : 'border-white/10'
                  }`}
                />
                <span className="text-2xs font-mono text-slate-500 w-16 text-right">
                  {formatBytes(r.file.size)}
                </span>
                {v.tooLarge && <span className="text-2xs font-mono text-red-400">too large</span>}
                {v.invalid && <span className="text-2xs font-mono text-red-400">invalid</span>}
                {!v.tooLarge && !v.invalid && v.overwrite && (
                  <span className="text-2xs font-mono text-amber-400">will overwrite</span>
                )}
                <button
                  onClick={() => removeRow(i)}
                  className="text-slate-500 hover:text-slate-200 transition-colors"
                  title="Remove from batch"
                >
                  <span className="material-symbols-outlined text-base">close</span>
                </button>
              </div>
            )
          })}
        </div>

        <div className="px-5 py-3 border-t border-white/10 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs font-mono text-slate-300 hover:text-slate-100 transition-colors"
          >Cancel</button>
          <button
            disabled={!allValid}
            onClick={() => onConfirm(rows)}
            className={`px-3 py-1.5 text-xs font-mono rounded transition-colors ${
              allValid
                ? 'bg-primary text-surface-base hover:bg-primary/90'
                : 'bg-white/5 text-slate-600 cursor-not-allowed'
            }`}
          >
            {anyOverwrite ? `Upload & overwrite ${rows.length} file${rows.length === 1 ? '' : 's'}` : `Upload ${rows.length} file${rows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function joinPath(dir: string, name: string): string {
  if (dir === '.' || dir === '') return name
  return `${dir.replace(/\/$/, '')}/${name}`
}
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

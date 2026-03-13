import { useState } from 'react'
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

  // Only count reconciled files in header totals
  const reconciledFiles = files.filter(f => !f.pending)
  const totalAdded = reconciledFiles.reduce((s, f) => s + f.additions, 0)
  const totalRemoved = reconciledFiles.reduce((s, f) => s + f.deletions, 0)

  return (
    <div className="flex flex-col h-full">
      {/* Summary bar */}
      <div className="px-3 py-1.5 border-b border-primary/10 bg-surface-base/50 flex items-center justify-between">
        <span className="text-2xs font-mono text-slate-500">{files.length} files</span>
        <div className="flex items-center gap-1.5 text-2xs font-mono">
          <span className="text-accent-green">+{totalAdded}</span>
          <span className="text-accent-red">-{totalRemoved}</span>
        </div>
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
    </div>
  )
}

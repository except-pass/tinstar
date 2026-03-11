import { useState } from 'react'
import type { RunData } from '../../types'
import { RunWorkspaceHeader } from './RunWorkspaceHeader'
import { TouchedFilesPanel } from './TouchedFilesPanel'
import { RunSessionPanel } from './RunSessionPanel'
import { ProceduresPanel } from './ProceduresPanel'

interface Props {
  run: RunData
  className?: string
  compact?: boolean
  /** Hide the header (used when an external drag handle replaces it) */
  headless?: boolean
}

export function RunWorkspaceWidget({ run, className = '', compact = false, headless = false }: Props) {
  const [filesCollapsed, setFilesCollapsed] = useState(compact)
  const [procsCollapsed, setProcsCollapsed] = useState(compact)

  return (
    <div className={`flex flex-col overflow-hidden neon-border bg-surface-base ${className}`}>
      {/* Header — hidden when drag handle replaces it */}
      {!headless && <RunWorkspaceHeader run={run} compact={compact} />}

      {/* Three-panel workspace */}
      <div className="flex flex-1 overflow-hidden">
        {filesCollapsed ? (
          <div
            data-testid="collapsed-files"
            className="w-6 flex flex-col items-center justify-center bg-surface-panel border-r border-primary/20 cursor-pointer hover:bg-surface-hover"
            onClick={() => setFilesCollapsed(false)}
          >
            <span className="text-2xs font-mono text-slate-500 [writing-mode:vertical-lr] rotate-180">Files</span>
          </div>
        ) : (
          <TouchedFilesPanel files={run.touchedFiles} onCollapse={() => setFilesCollapsed(true)} />
        )}
        <RunSessionPanel recapEntries={run.recapEntries} rawLogs={run.rawLogs} />
        {procsCollapsed ? (
          <div
            data-testid="collapsed-procedures"
            className="w-6 flex flex-col items-center justify-center bg-surface-panel cursor-pointer hover:bg-surface-hover"
            onClick={() => setProcsCollapsed(false)}
          >
            <span className="text-2xs font-mono text-slate-500 [writing-mode:vertical-lr]">Procs</span>
          </div>
        ) : (
          <ProceduresPanel procedures={run.procedures} onCollapse={() => setProcsCollapsed(true)} />
        )}
      </div>

    </div>
  )
}

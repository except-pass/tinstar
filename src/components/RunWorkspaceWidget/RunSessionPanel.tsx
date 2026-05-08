import { useState, useEffect, useCallback } from 'react'
import type { RecapEntry, SessionStatus } from '../../types'
import { resolveRunAccent } from '../runAccent'
import { apiFetch } from '../../apiClient'
import { RecapSessionPanel } from '../RecapSessionPanel'

interface Props {
  recapEntries?: RecapEntry[]
  rawLogs?: string
  port?: number | null
  sessionId?: string
  status?: SessionStatus
  color?: string
  termTick?: number
  terminalFocused?: boolean
  zoom?: number
  onTerminalToggle?: () => void
  onTerminalPointerFocus?: () => void
  /** Controlled active tab (0=recap, 1=terminal/logs) for keyboard navigation */
  activeTabIndex?: number
  onActiveTabChange?: (tab: 'recap' | 'terminal') => void
  /** When provided, the tab toggle is hidden (rendered in the header instead) */
  controlledTab?: 'recap' | 'terminal'
  onControlledTabChange?: (tab: 'recap' | 'terminal') => void
  /** Controlled prompt composer state */
  promptComposerExpanded?: boolean
  onPromptComposerToggle?: () => void
  /** Increment to focus the prompt composer textarea */
  composerFocusTrigger?: number
}

export function RunSessionPanel({ recapEntries = [], rawLogs = '', port, sessionId, status, color, termTick = 0, terminalFocused, zoom, onTerminalToggle, onTerminalPointerFocus, activeTabIndex, onActiveTabChange, controlledTab, onControlledTabChange, promptComposerExpanded, onPromptComposerToggle, composerFocusTrigger }: Props) {
  const accent = resolveRunAccent(color)
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === 'terminal-focus-toggle' && e.data?.sessionName === sessionId) {
        onTerminalToggle?.()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [sessionId, onTerminalToggle])

  const isTerminated = status === 'stopped'

  const handleResume = useCallback(async () => {
    if (!sessionId) return
    setActionError(null)
    setActionLoading(true)
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}/start`, { method: 'POST' })
      const data = await res.json()
      if (!data.ok) {
        const msg = data.error?.message ?? data.error?.code ?? 'Resume failed'
        setActionError(msg)
      }
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setActionLoading(false)
    }
  }, [sessionId])

  const handleDelete = useCallback(async () => {
    if (!sessionId) return
    setActionError(null)
    setActionLoading(true)
    try {
      const res = await apiFetch(`/api/sessions/${sessionId}`, { method: 'DELETE' })
      const data = await res.json()
      if (!data.ok) {
        const msg = data.error?.message ?? data.error?.code ?? 'Delete failed'
        setActionError(msg)
      }
    } catch (err) {
      setActionError((err as Error).message)
    } finally {
      setActionLoading(false)
    }
  }, [sessionId])

  return (
    <>
      {isTerminated && sessionId ? (
        <section className="flex-1 flex flex-col min-w-0 min-h-0 border-x border-primary/20 bg-surface-base">
          <div className="flex-1 flex flex-col items-center justify-center bg-black/50 gap-4 p-6">
            <span className="material-symbols-outlined text-4xl text-slate-500">terminal</span>
            <p className="text-sm font-mono text-slate-400 uppercase tracking-wider">
              Session {status}
            </p>
            {actionError && (
              <p className="text-xs font-mono text-accent-red bg-accent-red/10 border border-accent-red/30 px-3 py-2 rounded max-w-sm text-center">
                {actionError}
              </p>
            )}
            <div className="flex gap-3">
              <button
                onClick={handleResume}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-primary/20 border border-primary/40 text-primary text-xs font-mono uppercase tracking-wider hover:bg-primary/30 transition-colors disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-sm">play_arrow</span>
                Resume
              </button>
              <button
                onClick={handleDelete}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-accent-red/10 border border-accent-red/30 text-accent-red text-xs font-mono uppercase tracking-wider hover:bg-accent-red/20 transition-colors disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-sm">delete</span>
                Delete
              </button>
            </div>
          </div>
        </section>
      ) : (
        <RecapSessionPanel
          sessionId={sessionId}
          status={status}
          port={port ?? undefined}
          recapEntries={recapEntries}
          rawLogs={rawLogs}
          accent={accent}
          controlledTab={controlledTab}
          onControlledTabChange={onControlledTabChange}
          activeTabIndex={activeTabIndex}
          onActiveTabChange={onActiveTabChange}
          termTick={termTick}
          terminalFocused={terminalFocused}
          zoom={zoom}
          onTerminalPointerFocus={onTerminalPointerFocus}
          promptComposerExpanded={promptComposerExpanded}
          onPromptComposerToggle={onPromptComposerToggle}
          composerFocusTrigger={composerFocusTrigger}
        />
      )}
    </>
  )
}

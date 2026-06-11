// Vertical toolbar strip for page notes: add / submit / clear-all. Pure
// presentational — all behavior is lifted to BrowserPrimitive.
import { useEffect, useRef, useState } from 'react'

export interface NotesToolbarProps {
  placing: boolean
  unsentCount: number
  totalCount: number
  hasSession: boolean
  submitting: boolean
  submitError: string | null
  onTogglePlacing: () => void
  onSubmit: () => void
  onClearAll: () => void
  accent: string
}

export function NotesToolbar(p: NotesToolbarProps) {
  // Clear-all is a two-click confirm (re-click within 2s) — snappy, no modal.
  // confirmArmedRef is the source of truth for the handler (avoids stale-closure
  // issues with fake timers in tests); confirmArmed drives the visual update.
  const confirmArmedRef = useRef(false)
  const [confirmArmed, setConfirmArmed] = useState(false)
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (disarmTimer.current) clearTimeout(disarmTimer.current) }, [])

  const handleClear = () => {
    if (confirmArmedRef.current) {
      if (disarmTimer.current) clearTimeout(disarmTimer.current)
      confirmArmedRef.current = false
      setConfirmArmed(false)
      p.onClearAll()
    } else {
      if (disarmTimer.current) clearTimeout(disarmTimer.current)
      confirmArmedRef.current = true
      setConfirmArmed(true)
      disarmTimer.current = setTimeout(() => {
        confirmArmedRef.current = false
        setConfirmArmed(false)
      }, 2000)
    }
  }

  const submitDisabled = !p.hasSession || p.unsentCount === 0 || p.submitting
  const submitTitle = !p.hasSession
    ? 'Attach a session to submit notes'
    : p.unsentCount === 0 ? 'No unsent notes' : `Send ${p.unsentCount} note${p.unsentCount === 1 ? '' : 's'} to the session`

  return (
    <div
      className="flex flex-col items-center gap-1 px-1 py-1.5 border-l border-white/10 bg-surface-panel flex-shrink-0 w-8"
      onPointerDown={e => e.stopPropagation()}
      data-testid="bw-notes-toolbar"
    >
      <button
        data-testid="bw-notes-add"
        onClick={p.onTogglePlacing}
        className={`rounded p-0.5 transition-colors ${p.placing ? 'text-primary bg-white/10' : 'text-slate-500 hover:text-slate-300'}`}
        title={p.placing ? 'Cancel note placement (Esc)' : 'Add note — then click anywhere on the page'}
      >
        <span className="material-symbols-outlined text-base">add_comment</span>
      </button>
      <button
        data-testid="bw-notes-submit"
        onClick={p.onSubmit}
        disabled={submitDisabled}
        className={`relative rounded p-0.5 transition-colors ${submitDisabled ? 'text-slate-700' : 'text-slate-400 hover:text-primary'}`}
        title={submitTitle}
      >
        <span className="material-symbols-outlined text-base">{p.submitting ? 'hourglass_empty' : 'send'}</span>
        {p.unsentCount > 0 && (
          <span
            data-testid="bw-notes-unsent-badge"
            className="absolute -top-1 -right-1 min-w-[14px] h-[14px] rounded-full text-[8px] text-white flex items-center justify-center px-0.5 font-mono leading-none"
            style={{ background: p.accent }}
          >
            {p.unsentCount > 99 ? '!' : p.unsentCount}
          </span>
        )}
      </button>
      {p.submitError && (
        <span
          data-testid="bw-notes-error"
          className="material-symbols-outlined text-base text-red-400"
          title={`Submit failed: ${p.submitError} — notes kept unsent`}
        >
          error
        </span>
      )}
      {p.totalCount > 0 && (
        <button
          data-testid="bw-notes-clear"
          onClick={handleClear}
          className={`rounded p-0.5 transition-colors ${confirmArmed ? 'text-red-400 bg-red-500/10' : 'text-slate-600 hover:text-slate-400'}`}
          title={confirmArmed ? 'Click again to clear ALL notes' : 'Clear all notes'}
        >
          <span className="material-symbols-outlined text-base">delete_sweep</span>
        </button>
      )}
    </div>
  )
}

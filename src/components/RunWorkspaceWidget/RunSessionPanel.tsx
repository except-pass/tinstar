import { useState, useRef, useEffect, useCallback, useReducer } from 'react'
import type { RecapEntry, DiffBlock, SessionStatus } from '../../types'

function DiffView({ diff }: { diff: DiffBlock }) {
  return (
    <div className="border border-primary/15 bg-surface-base rounded-sm overflow-hidden mt-2">
      <div className="flex items-center gap-2 px-2 py-1 bg-primary/[0.06] border-b border-primary/15 text-2xs text-primary/60 font-mono">
        <span className="material-symbols-outlined text-xs">difference</span>
        {diff.filename}
        <span className="text-slate-600 ml-auto">{diff.header}</span>
      </div>
      <pre className="px-2 py-1.5 text-2xs leading-relaxed font-mono overflow-x-auto">
        {diff.lines.map((line, i) => (
          <div
            key={i}
            className={
              line.type === 'addition'
                ? 'text-accent-green bg-accent-green/[0.06]'
                : line.type === 'deletion'
                  ? 'text-accent-red bg-accent-red/[0.06]'
                  : line.type === 'header'
                    ? 'text-slate-500'
                    : 'text-slate-400'
            }
          >
            <span className="select-none text-slate-600 inline-block w-3">
              {line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' '}
            </span>
            {line.content}
          </div>
        ))}
      </pre>
    </div>
  )
}

function AgentMessage({ entry }: { entry: RecapEntry }) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-6 h-6 border border-primary/40 flex items-center justify-center bg-primary/10">
        <span className="material-symbols-outlined text-primary text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>
          smart_toy
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-2xs font-mono text-primary/50 tracking-wide">AGENT</span>
          {entry.timestamp && (
            <span className="text-2xs font-mono text-slate-600">{entry.timestamp}</span>
          )}
        </div>
        <p className="text-xs font-mono leading-relaxed text-slate-300">
          {entry.content}
        </p>
        {entry.diff && <DiffView diff={entry.diff} />}
      </div>
    </div>
  )
}

function UserMessage({ entry }: { entry: RecapEntry }) {
  return (
    <div className="flex gap-3 flex-row-reverse">
      <div className="shrink-0 w-6 h-6 border border-slate-600 flex items-center justify-center bg-surface-raised">
        <span className="material-symbols-outlined text-slate-400 text-sm">person</span>
      </div>
      <div className="flex-1 min-w-0 text-right">
        <div className="flex items-center gap-2 justify-end mb-1">
          {entry.timestamp && (
            <span className="text-2xs font-mono text-slate-600">{entry.timestamp}</span>
          )}
          <span className="text-2xs font-mono text-slate-500 tracking-wide">YOU</span>
        </div>
        <p className="text-xs font-mono leading-relaxed text-primary/70 bg-primary/[0.04] p-2.5 border-r-2 border-primary/40 text-left">
          {entry.content}
        </p>
      </div>
    </div>
  )
}

function StatusMessage({ entry }: { entry: RecapEntry }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent to-primary/15" />
      <div className="flex items-center gap-2 text-2xs font-mono text-primary/50 tracking-wide uppercase">
        <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse-glow shadow-[0_0_4px_#00f0ff]" />
        {entry.content}
      </div>
      <div className="h-px flex-1 bg-gradient-to-l from-transparent to-primary/15" />
    </div>
  )
}

/** Iframe wrapper keyed by tick to force remount on refresh */
function TerminalFrame({ src, tick }: { src: string; tick: number }) {
  return (
    <div className="flex-1 flex" onPointerDown={e => e.stopPropagation()}>
      <iframe
        key={tick}
        src={src}
        className="flex-1 w-full border-0 bg-black"
        title="Session terminal"
        allow="clipboard-read; clipboard-write"
      />
    </div>
  )
}

interface Props {
  recapEntries: RecapEntry[]
  rawLogs: string
  port?: number | null
  sessionId?: string
  status?: SessionStatus
}

export function RunSessionPanel({ recapEntries, rawLogs, port, sessionId, status }: Props) {
  const [activeTab, setActiveTab] = useState<'recap' | 'terminal'>(port ? 'terminal' : 'recap')
  const [actionError, setActionError] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [termTick, bumpTerm] = useReducer((n: number) => n + 1, 0)

  const refreshTerminal = useCallback(() => {
    if (!sessionId) { bumpTerm(); return }
    // Re-register the Caddy route (may have been lost), then reload iframe
    fetch(`/api/sessions/${sessionId}/refresh-route`, { method: 'POST' })
      .finally(() => bumpTerm())
  }, [sessionId])
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [activeTab])

  const isTerminated = status === 'stopped'

  const handleResume = useCallback(async () => {
    if (!sessionId) return
    setActionError(null)
    setActionLoading(true)
    try {
      const res = await fetch(`/api/sessions/${sessionId}/start`, { method: 'POST' })
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
      const res = await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' })
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
    <section className="flex-1 flex flex-col min-w-0 border-x border-primary/20 bg-surface-base">
      {/* Tab toggle */}
      <div className="flex items-center justify-center border-b border-primary/20 py-2 bg-surface-panel relative">
        <div className="flex border border-primary/25 rounded-sm overflow-hidden">
          {([
            { key: 'recap' as const, label: 'Recap' },
            { key: 'terminal' as const, label: port ? 'Terminal' : 'Logs' },
          ]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`
                px-5 py-1 text-2xs font-bold font-display tracking-[0.15em] uppercase transition-all
                ${activeTab === key
                  ? 'bg-primary text-surface-base'
                  : 'text-primary/50 hover:text-primary hover:bg-primary/[0.06]'
                }
              `}
            >
              {label}
            </button>
          ))}
        </div>
        {activeTab === 'terminal' && port && (
          <button
            onClick={refreshTerminal}
            className="absolute right-2 p-1 rounded text-slate-500 hover:text-primary transition-colors"
            title="Reload terminal (re-registers proxy route)"
          >
            <span className="material-symbols-outlined text-sm">refresh</span>
          </button>
        )}
      </div>

      {/* Content */}
      {isTerminated && sessionId ? (
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
      ) : activeTab === 'terminal' && port ? (
        <TerminalFrame src={sessionId ? `/s/${sessionId}/` : `http://localhost:${port}`} tick={termTick} />
      ) : activeTab === 'recap' ? (
        <div ref={contentRef} className="flex-1 overflow-y-auto scrollbar-thin p-4">
          <div className="space-y-5">
            {recapEntries.map((entry) => {
              switch (entry.type) {
                case 'agent': return <AgentMessage key={entry.id} entry={entry} />
                case 'user': return <UserMessage key={entry.id} entry={entry} />
                case 'status': return <StatusMessage key={entry.id} entry={entry} />
              }
            })}
          </div>
        </div>
      ) : (
        <div ref={contentRef} className="flex-1 overflow-y-auto scrollbar-thin p-4">
          <pre className="text-2xs font-mono leading-relaxed text-slate-400 whitespace-pre-wrap">
            {rawLogs.split('\n').map((line, i) => (
              <div
                key={i}
                className={`py-px ${
                  line.includes('PASS') ? 'text-accent-green' :
                  line.includes('FAIL') ? 'text-accent-red' :
                  line.includes('claude-agent:') ? 'text-accent-amber/70' :
                  ''
                }`}
              >
                {line}
              </div>
            ))}
          </pre>
        </div>
      )}

    </section>
  )
}

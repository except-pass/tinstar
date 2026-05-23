import { useEffect, useState, useCallback, useRef } from 'react'
import { apiFetch } from '../../apiClient'
import { useServerEvents } from '../../hooks/useServerEvents'
import { RecapSessionPanel } from '../RecapSessionPanel'
import { hexToRgba } from '../runAccent'
import { getPref, setPref } from '../../lib/uiPrefs'

type MarshalState =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'ready'; port: number; sessionName: string }
  | { phase: 'error'; message: string }

/** Self-contained marshal panel for the canvas sidebar. Owns the marshal
 *  session lifecycle (ensure/restart) and renders the shared RecapSessionPanel
 *  with Recap as the default tab. */
export function MarshalTerminal({ accent = '#00f0ff' }: { accent?: string }) {
  const [state, setState] = useState<MarshalState>({ phase: 'idle' })
  const [tick, setTick] = useState(0)
  const [tab, setTab] = useState<'recap' | 'terminal'>('recap')
  const [visible, setVisible] = useState(() => getPref('marshalVisible') ?? true)
  const ensuringRef = useRef(false)
  const { state: serverState } = useServerEvents()
  const marshal = serverState.marshal

  useEffect(() => { setPref('marshalVisible', visible) }, [visible])
  const toggleVisible = useCallback(() => setVisible(v => !v), [])

  const ensure = useCallback(async () => {
    if (ensuringRef.current) return
    ensuringRef.current = true
    setState({ phase: 'creating' })
    try {
      const res = await apiFetch('/api/marshal/ensure', { method: 'POST' })
      const body = await res.json() as { ok: boolean; data?: { name: string; port?: number; state?: string }; error?: { message?: string } }
      if (!body.ok || !body.data?.port) {
        setState({ phase: 'error', message: body.error?.message ?? 'marshal session has no port yet' })
      } else {
        setState({ phase: 'ready', port: body.data.port, sessionName: body.data.name })
      }
    } catch (err) {
      setState({ phase: 'error', message: (err as Error).message })
    } finally {
      ensuringRef.current = false
    }
  }, [])

  useEffect(() => { void ensure() }, [ensure])

  const refresh = useCallback(() => {
    if (state.phase === 'ready') setTick(t => t + 1)
    else void ensure()
  }, [state.phase, ensure])

  const restart = useCallback(async () => {
    if (ensuringRef.current) return
    ensuringRef.current = true
    setState({ phase: 'creating' })
    try {
      const res = await apiFetch('/api/marshal/restart', { method: 'POST' })
      const body = await res.json() as { ok: boolean; data?: { name: string; port?: number; state?: string }; error?: { message?: string } }
      if (!body.ok || !body.data?.port) {
        setState({ phase: 'error', message: body.error?.message ?? 'marshal session has no port yet' })
      } else {
        setState({ phase: 'ready', port: body.data.port, sessionName: body.data.name })
        setTick(t => t + 1)
      }
    } catch (err) {
      setState({ phase: 'error', message: (err as Error).message })
    } finally {
      ensuringRef.current = false
    }
  }, [])

  // Marshal sessionId is the canonical name; even before /ensure resolves, the
  // SSE snapshot may already have the marshal Run, which lets the composer
  // work on the recap tab.
  const sessionId = marshal?.sessionId ?? (state.phase === 'ready' ? state.sessionName : undefined)
  const port = state.phase === 'ready' ? state.port : undefined
  const status = marshal?.status

  if (!visible) {
    return (
      <button
        onClick={toggleVisible}
        className="block w-full px-2 py-1 bg-surface-base/50 border-t border-white/10 text-slate-500 hover:text-slate-300 transition-colors select-none text-2xs font-mono uppercase tracking-wider"
        title="Show marshal"
        data-testid="marshal-toggle"
      >
        <span className="material-symbols-outlined align-middle mr-1" style={{ fontSize: '14px' }}>shield_person</span>
        marshal
      </button>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="marshal-terminal">
      <div
        className="flex items-center justify-between px-2 py-1 border-y border-white/10 bg-surface-base/60 text-2xs font-mono uppercase tracking-wider select-none"
        style={{ color: accent }}
      >
        <div className="flex items-center gap-1.5">
          <span className="material-symbols-outlined" style={{ fontSize: 12 }}>shield_person</span>
          <span>marshal</span>
          {state.phase === 'creating' && <span className="text-slate-500 normal-case tracking-normal">starting…</span>}
          {state.phase === 'error' && <span className="text-accent-red normal-case tracking-normal">error</span>}
        </div>
        <div className="flex rounded-sm overflow-hidden border" style={{ borderColor: hexToRgba(accent, 0.25) }}>
          {([
            { key: 'recap' as const, label: 'Recap' },
            { key: 'terminal' as const, label: port ? 'Term' : 'Logs' },
          ]).map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              aria-selected={tab === key}
              data-testid={`marshal-tab-${key}`}
              className="px-2 py-0 text-2xs font-bold tracking-[0.1em] uppercase transition-colors"
              style={tab === key
                ? { background: accent, color: 'var(--surface-base)' }
                : { color: hexToRgba(accent, 0.5) }
              }
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={refresh}
            className="text-slate-500 hover:text-slate-300"
            title="Refresh marshal terminal"
            data-testid="marshal-refresh"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>refresh</span>
          </button>
          <button
            onClick={() => void restart()}
            className="text-slate-500 hover:text-accent-red"
            title="Tear down the marshal session and start a fresh one (use when refresh isn't enough — e.g. after a crash)"
            data-testid="marshal-restart"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>power_settings_new</span>
          </button>
          <button
            onClick={toggleVisible}
            className="text-slate-500 hover:text-slate-300"
            title="Hide marshal"
            data-testid="marshal-collapse"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
          </button>
        </div>
      </div>

      {state.phase === 'error' && !marshal ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-2xs font-mono text-slate-400 p-4 text-center bg-black">
          <div className="text-accent-red">marshal failed to start</div>
          <div className="text-slate-500 break-words">{state.message}</div>
          <button
            onClick={ensure}
            className="px-3 py-1 border border-white/10 text-slate-300 hover:text-white"
          >retry</button>
        </div>
      ) : (
        <RecapSessionPanel
          sessionId={sessionId}
          status={status}
          port={port}
          recapEntries={marshal?.recapEntries ?? []}
          accent={accent}
          controlledTab={tab}
          onControlledTabChange={setTab}
          termTick={tick}
        />
      )}
    </div>
  )
}

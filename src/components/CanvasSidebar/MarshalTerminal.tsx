import { useEffect, useState, useCallback, useRef } from 'react'
import { apiFetch } from '../../apiClient'

type MarshalState =
  | { phase: 'idle' }
  | { phase: 'creating' }
  | { phase: 'ready'; port: number; sessionName: string }
  | { phase: 'error'; message: string }

const TERMINAL_TICK_KEY = 0

/** Self-contained marshal terminal panel. Ensures the marshal session exists
 * on mount and embeds its TTYD wrapper in an iframe. */
export function MarshalTerminal({ accent = '#00f0ff' }: { accent?: string }) {
  const [state, setState] = useState<MarshalState>({ phase: 'idle' })
  const [tick, setTick] = useState(TERMINAL_TICK_KEY)
  const ensuringRef = useRef(false)

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
        <button
          onClick={refresh}
          className="text-slate-500 hover:text-slate-300"
          title="Refresh marshal terminal"
          data-testid="marshal-refresh"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>refresh</span>
        </button>
      </div>
      <div className="flex-1 min-h-0 relative bg-black">
        {state.phase === 'ready' ? (
          <iframe
            key={tick}
            src={`/terminal-wrapper.html?session=${encodeURIComponent(state.sessionName)}&port=${state.port}`}
            style={{ display: 'block', width: '100%', height: '100%', border: 0, background: 'black' }}
            title="Marshal terminal"
            allow="clipboard-read; clipboard-write"
          />
        ) : state.phase === 'error' ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-2xs font-mono text-slate-400 p-4 text-center">
            <div className="text-accent-red">marshal failed to start</div>
            <div className="text-slate-500 break-words">{state.message}</div>
            <button
              onClick={ensure}
              className="px-3 py-1 border border-white/10 text-slate-300 hover:text-white"
            >retry</button>
          </div>
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-2xs font-mono text-slate-500 select-none">
            spinning up marshal…
          </div>
        )}
      </div>
    </div>
  )
}

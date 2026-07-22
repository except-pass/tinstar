// The "Explain the session" button — one click asks the run's agent to fan the whole
// session onto its Slate as several surfaces (common kinds + its own).
//
// It POSTs to …/slate/explain, which persists NOTHING and delivers a multi-surface
// authoring nudge best-effort (the agent writes the .tinstar/slate/*.json files; the
// surfaces then arrive over the SSE run delta like any other). So the button owns only
// a tiny transient state: `asking` while the POST is in flight, then back to `idle` on
// delivery, or a small note when the run is unreachable / the request errored.
//
// Self-contained (its own POST + state) so it can render in BOTH mount points without
// threading a handler through props: the Slate header (re-explain / add more) and the
// empty-Slate strip (bootstrap an empty Slate). Only one is ever mounted at a time — the
// column and the strip are mutually exclusive — so the two instances never collide.
import { useCallback, useState } from 'react'
import { apiFetch } from '../../apiClient'

type ExplainState = 'idle' | 'asking' | 'unreachable' | 'error'

export function SlateExplainButton({ runId, className }: { runId: string; className?: string }) {
  const [state, setState] = useState<ExplainState>('idle')

  const ask = useCallback(async () => {
    if (state === 'asking') return // one in flight at a time
    setState('asking')
    try {
      const res = await apiFetch(`/api/runs/${runId}/slate/explain`, { method: 'POST' })
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; data?: { delivered?: boolean } }
        | null
      if (!res.ok || !body?.ok) { setState('error'); return }
      // delivered:false — the run is asleep. Nothing is coming; say so. Otherwise the
      // surfaces will arrive over the SSE run delta, so drop back to idle.
      setState(body.data?.delivered === false ? 'unreachable' : 'idle')
    } catch {
      setState('error')
    }
  }, [runId, state])

  return (
    <span className="inline-flex items-center gap-1">
      <button
        data-testid="slate-explain"
        onClick={() => void ask()}
        disabled={state === 'asking'}
        title="Ask the agent to explain this session as Slate surfaces"
        className={`text-2xs font-mono text-primary hover:text-primary/80 disabled:opacity-70 ${className ?? ''}`}
      >
        {state === 'asking' ? 'asking…' : '✦ Explain'}
      </button>
      {state === 'unreachable' && (
        <span data-testid="slate-explain-unreachable" className="text-2xs text-ink-low">
          not reachable
        </span>
      )}
      {state === 'error' && (
        <span data-testid="slate-explain-error" className="text-2xs text-hue-error">
          failed
        </span>
      )}
    </span>
  )
}

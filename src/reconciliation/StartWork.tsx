import { useRef, useState } from 'react'
import { workflowSaved } from './workflowSaved'
import { apiFetch } from '../apiClient'
import type { FloorScene } from '../shared/reconciliationPresentation'
import type { StartWorkInput, StartWorkResult } from '../shared/workflow'

/** Compact Inspector action. Server policy is authoritative for every choice. */
export function StartWork({ cardId, scene, onSaved }: { cardId: string; scene: FloorScene; onSaved: (result?: StartWorkResult) => Promise<void> }) {
  const [mode, setMode] = useState('firstmate'), [selected, setSelected] = useState('')
  const [system, setSystem] = useState(''), [run, setRun] = useState(''), [reference, setReference] = useState(''), [evidence, setEvidence] = useState('')
  const [observed, setObserved] = useState(''), [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false), [result, setResult] = useState<StartWorkResult | null>(null)
  const attempt = useRef<{ signature: string; input: StartWorkInput }>()
  const workers = scene.executions.filter(worker => worker.kind !== 'secondmate')
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const worker = workers.find(worker => worker.id === selected)
    const provenance: StartWorkInput['worker'] | null = mode === 'firstmate' ? worker && worker.identity.task_id && worker.identity.spawn_gen ? {
      kind: 'firstmate', fm_home: worker.home, task_id: worker.identity.task_id, first_observed_spawn_gen: worker.identity.spawn_gen,
    } : null : { kind: 'external', system, run_id: run, reference, card_id: cardId, observed_at: observed, state: 'running', evidence }
    if (!provenance) return
    const signature = JSON.stringify([cardId, provenance])
    if (attempt.current?.signature !== signature) attempt.current = { signature, input: { card_id: cardId, operation_id: crypto.randomUUID(), worker: provenance } }
    setBusy(true); setResult(null)
    try {
      const response = await apiFetch('/api/reconciliation/workflow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' }, body: JSON.stringify({ operation: 'start', input: attempt.current.input }) })
      const body = await response.json()
      if (!response.ok || !body.ok || !body.data) throw new Error(body.error?.message ?? 'Start work unavailable')
      const saved = body.data as StartWorkResult
      setResult(saved)
      if (saved.outcome !== 'not-saved') { await onSaved(saved).catch(() => {}); workflowSaved() }
    } catch { setResult({ outcome: 'partially-saved', code: 'response-unavailable', operation_id: attempt.current.input.operation_id, saved_fields: [], message: 'Not confirmed saved. Refresh the card, then retry; the same attempt will be reused.' }) }
    finally { setBusy(false) }
  }
  return <details className="ov-start-work"><summary>Start work</summary>
    <form onSubmit={event => void submit(event)}>
      <p>Link a currently executing worker and set In Progress. The server checks its evidence before saving.</p>
      <label>Worker system <select value={mode} onChange={event => setMode(event.target.value)}><option value="firstmate">First Mate</option><option value="external">External tracked run</option></select></label>
      {mode === 'firstmate' ? <label>Tracked worker <select required value={selected} onChange={event => setSelected(event.target.value)}><option value="">Choose a worker</option>{workers.map(worker => <option key={worker.id} value={worker.id}>{worker.identity.task_id} · {worker.home} · {worker.activity} · {worker.observation.status}</option>)}</select></label>
        : <>
          <label>System <input required value={system} onChange={event => setSystem(event.target.value)} placeholder="Execution system" /></label>
          <label>Run ID <input required value={run} onChange={event => setRun(event.target.value)} /></label>
          <label>Run reference <input required type="url" value={reference} onChange={event => setReference(event.target.value)} /></label>
          <label>Observed at (ISO timestamp with timezone) <input required value={observed} onChange={event => setObserved(event.target.value)} placeholder="2026-11-10T12:00:00Z" /></label>
          <label>Execution evidence <textarea required minLength={12} maxLength={2000} value={evidence} onChange={event => setEvidence(event.target.value)} /></label>
          <label><input type="checkbox" required checked={running} onChange={event => setRunning(event.target.checked)} /> This tracked run is currently executing this card</label>
          <p>Saved as your reported evidence, with the run’s own system and identity.</p>
        </>}
      <button type="submit" disabled={busy}>{busy ? 'Saving start…' : 'Start work'}</button>
      {result && <p role="status" data-save-outcome={result.outcome}>{result.outcome === 'saved' ? 'Saved. ' : result.outcome === 'partially-saved' ? 'Partially saved. ' : 'Not saved. '}{result.message}{result.saved_fields.length > 0 && ` Confirmed: ${result.saved_fields.join(', ')}.`}</p>}
    </form>
  </details>
}

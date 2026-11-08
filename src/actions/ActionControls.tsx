import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { apiFetch } from '../apiClient'
import { AskCardAction, useAskControls } from '../ask/Ask'
import { AskSurface } from '../ask/AskSurface'
import type { AskView } from '../shared/ask'
import { candidateSchema, type ActionCandidate, ActionCatalog, ActionReceipt, InstalledAction } from '../shared/actions'
import type { ReleasePull, PullIdentity } from '../shared/releases'
import './actions.css'

type Target = PullIdentity & { head?: string | null; base?: string; state?: string; freshness?: string }
async function request(path: string, payload?: unknown) {
  const response = await apiFetch(path, { headers: { 'X-Tinstar-UI': '1', ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { method: 'POST', body: JSON.stringify(payload) } : {}) })
  const result = await response.json()
  if (!response.ok || !result.ok) throw new Error(result.error?.message ?? 'Local action request failed')
  return result.data
}
/** One component/store/executor contract in both PRs and Releases. No mutation route
 * exists; the API only simulates trusted fixtures and records local receipts. */
export function ActionControls({ targets, view, compact = false, focusReceipt }: { targets: Target[]; view: AskView; compact?: boolean; focusReceipt?: string }) {
  const asks = useAskControls(), root = useRef<HTMLDivElement>(null)
  const [unavailable, setUnavailable] = useState('')
  const [catalog, setCatalog] = useState<ActionCatalog | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [inspect, setInspect] = useState(false), [candidate, setCandidate] = useState<ActionCandidate | null>(null), [custom, setCustom] = useState(''), [inspected, setInspected] = useState(false)
  const [mode, setMode] = useState<'direct' | 'coordinated'>('direct'), [runId, setRunId] = useState<string | null>(null)
  const [repairChoice, setRepairChoice] = useState<'none' | 'update' | 'rerun'>('none'), [jobId, setJobId] = useState(''), [jobRunId, setJobRunId] = useState('')
  const [versions, setVersions] = useState<Record<string, string[]>>({})
  const refresh = async () => { try { setCatalog(await request('/api/actions')); setError('') } catch (error) { setError((error as Error).message) } }
  useEffect(() => { let active = true; void request('/api/actions').then(data => { if (active && Array.isArray(data.installed) && Array.isArray(data.receipts)) setCatalog(data) }).catch(error => { if (active) setUnavailable(error.message) }); return () => { active = false } }, [])
  const pending = !!runId && (!catalog?.receipts.some(row => row.runId === runId) || catalog.receipts.some(row => row.runId === runId && row.outcome === 'intent'))
  useEffect(() => {
    if (!pending) return
    const timer = setInterval(() => { void refresh() }, 1000)
    return () => clearInterval(timer)
  }, [pending])
  const perform = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work(); await refresh() } catch (error) { setError((error as Error).message) } finally { setBusy(false) } }
  const invoke = (action: InstalledAction) => void perform(async () => {
    if (repairChoice !== 'none' && targets.length !== 1) throw new Error('Repair extras require exactly one selected PR and explicit invocation')
    if (repairChoice === 'rerun' && (!/^[1-9]\d*$/.test(jobId) || !/^[1-9]\d*$/.test(jobRunId))) throw new Error('Enter the exact failed job and run IDs')
    const repair = action.manifest.id !== 'fix-ci' || repairChoice === 'none' ? undefined : repairChoice === 'update' ? { kind: 'repair.update', ref: '', expectedHead: targets[0]?.head } : { kind: 'repair.rerun', jobId: Number(jobId), runId: Number(jobRunId), attempt: 1, expectedHead: targets[0]?.head }
    // The safe head ref is supplied by the capture endpoint, never inferred from base/main.
    if (repair?.kind === 'repair.update') { const captured = await request('/api/actions/capture', { target: { url: targets[0]!.url, head: targets[0]!.head, base: targets[0]!.base ?? 'main' } }); repair.ref = `refs/heads/${captured.headRef}` }
    const result = await request('/api/actions/run', { key: crypto.randomUUID(), action: action.manifest.id, version: action.manifest.version, targets: targets.map(target => ({ url: target.url, head: target.head, base: target.base ?? 'main' })), mode, view, ...(repair ? { repair } : {}) })
    setRunId(result.runId)
  })
  const disabled = (action: InstalledAction) => {
    if (busy || pending || !targets.length || targets.some(target => !target.head || target.freshness === 'stale')) return 'Select PRs with current captured heads'
    if (action.manifest.capabilities.some(cap => cap.startsWith('merge.') || cap.startsWith('repair.')) && targets.some(target => target.state !== undefined && target.state !== 'open')) return 'Merge and repair are disabled on merged or closed PRs'
    if (targets.some(target => !action.grant.repositories.includes(target.repository))) return 'Selection outside installed grant'
    if (action.manifest.capabilities.includes('merge.admin')) return catalog?.policy.unknownReason ?? 'Check inventory unavailable; Admin Merge disabled'
    return ''
  }
  useLayoutEffect(() => {
    if (!focusReceipt || !catalog) return
    const row = [...root.current?.querySelectorAll<HTMLElement>('[data-action-receipt]') ?? []].find(row => row.dataset.actionReceipt === focusReceipt)
    row?.scrollIntoView?.({ block: 'center' }); row?.focus({ preventScroll: true })
  }, [focusReceipt, catalog])
  const rows = catalog?.receipts.filter(receipt => targets.some(target => target.url === receipt.captured.url)) ?? []
  return <div ref={root} className={`installed-actions${compact ? ' is-compact' : ''}`} aria-label="Installed PR actions">
    {(!compact || !!catalog?.installed.length) && <span className="action-buttons">{catalog?.installed.map(action => <button key={action.manifest.id} type="button" disabled={!!disabled(action)} title={disabled(action) || `Simulate ${action.manifest.name}`} onClick={() => invoke(action)}>{action.manifest.name}{' '}<small> · Simulated</small></button>)}</span>}
    {!compact && <>
      {targets.length === 1 && catalog?.installed.some(action => action.manifest.id === 'fix-ci') && <details><summary>Fix CI repair options · simulated</summary><label>Explicit operation <select value={repairChoice} onChange={event => setRepairChoice(event.target.value as typeof repairChoice)}><option value="none">Classify / propose repair</option><option value="update">Safe update selected branch</option><option value="rerun">Rerun one failed job once</option></select></label>{repairChoice === 'rerun' && <><label>Failed job ID <input value={jobId} onChange={event => setJobId(event.target.value)} /></label><label>Run ID <input value={jobRunId} onChange={event => setJobRunId(event.target.value)} /></label></>}</details>}
      {targets.length > 1 && <label>Mode <select value={mode} onChange={event => setMode(event.target.value as typeof mode)}><option value="direct">Direct</option><option value="coordinated">Coordinated · serialized plan</option></select></label>}
      <button type="button" onClick={() => setInspect(value => !value)}>Inspect / install actions</button>
      {targets[0] && <button type="button" onClick={() => asks?.open({ target: { kind: 'pull', id: targets[0]!.id, ...(targets[0]!.head ? { head: targets[0]!.head } : {}) }, label: 'Make a button that does X on selected PRs', question: 'Make a button that does X on selected PRs.', view, field_key: 'description', field_value: 'Make a button that does X on selected PRs. Return deterministic implementation.mjs source, manifest, tests and requested capabilities for owner inspection. Installation is separate; custom code execution is held until approved OS isolation exists.' })}>Make a button…</button>}
      {pending && <button type="button" onClick={() => void perform(async () => { await request('/api/actions/cancel', { runId }) })}>Cancel unsent proposals</button>}
      {inspect && <section className="action-inspect" aria-label="Inspect installed actions">
        <p role={unavailable ? 'status' : undefined}>{unavailable}</p>
        <p>Simulated actions · actual GitHub writes = 0. {catalog?.runner}</p>
        <p>Admin Merge disabled: {catalog?.policy.unknownReason}</p>
        <div>{catalog?.examples.map(example => <button key={example.manifest.id} type="button" onClick={() => { setCandidate(example); setInspected(false) }}>Inspect {example.manifest.name} candidate</button>)}</div>
        {catalog?.installed.map(action => <section key={action.manifest.id}>
          <button type="button" onClick={() => void perform(async () => { const data = await request(`/api/actions/inspect?id=${action.manifest.id}`); setCandidate(data.installed); setInspected(false); setVersions(previous => ({ ...previous, [action.manifest.id]: data.versions })) })}>Inspect {action.manifest.name} · {action.manifest.version}</button>
          <pre>{JSON.stringify(action.grant, null, 2)}</pre>
          {versions[action.manifest.id]?.filter(version => version !== action.manifest.version).map(version => <button key={version} type="button" disabled={busy} onClick={() => void perform(async () => { await request('/api/actions/rollback', { id: action.manifest.id, version }) })}>Rollback to {version}</button>)}
        </section>)}
        <details><summary>Inspect a Custom candidate from First Mate</summary><label>Candidate JSON (manifest + source)<textarea value={custom} onChange={event => setCustom(event.target.value)} /></label><button type="button" onClick={() => { try { setCandidate(candidateSchema.parse(JSON.parse(custom))); setInspected(false); setError('') } catch { setError('Invalid candidate JSON') } }}>Inspect candidate</button></details>
        {candidate && <section><h3>{candidate.manifest?.name} · {candidate.manifest?.version}</h3><pre>{candidate.source}</pre><pre>{JSON.stringify(candidate.manifest, null, 2)}</pre>
          <label><input type="checkbox" checked={inspected} onChange={event => setInspected(event.target.checked)} />I inspected this source, test evidence and requested grants for this immutable version.</label>
          <button type="button" disabled={!inspected || busy || catalog?.installed.some(action => action.manifest.id === candidate.manifest?.id && action.manifest.version === candidate.manifest?.version)} onClick={() => void perform(async () => { await request('/api/actions/install', { candidate, inspected: true }); setCandidate(null); setInspected(false) })}>Install inspected version locally</button>
        </section>}
      </section>}
    </>}
    {busy && <span role="status">Recording local action…</span>}{error && <p role="alert">{error}</p>}
    {!!rows.length && <details open={!!runId || !!focusReceipt} className="action-history"><summary onClick={() => void refresh()}>Action receipts ({rows.length}) · GitHub writes = 0</summary>{rows.map(receipt => <ActionReceiptView key={receipt.id} receipt={receipt} view={view} />)}</details>}
  </div>
}
function ActionReceiptView({ receipt, view }: { receipt: ActionReceipt; view: AskView }) {
  const identity = receipt.live
  const target = { kind: 'pull' as const, id: identity?.id ?? `${new URL(receipt.captured.url).pathname.split('/').slice(1, 3).join('/')}#${receipt.captured.url.split('/').pop()}`, head: receipt.captured.head, action_receipt_id: receipt.id }
  const subject = { target, label: `Action receipt · ${receipt.actionId} · ${receipt.outcome}`, view }
  return <AskSurface as="section" subject={subject} tabIndex={-1} data-action-receipt={receipt.id} data-ask-field="receipt" className="action-receipt">
    <strong>{receipt.outcome === 'simulated' ? 'Simulated' : receipt.outcome} · {receipt.actionId}</strong> <AskCardAction subject={subject} icon />
    <p>{receipt.intendedEffect}<br />{receipt.result}</p><p>Actor {receipt.actor} · {receipt.version} · {receipt.credentialProfile} · actual GitHub writes = 0</p>
    {receipt.reasons.map(reason => <p key={reason}>{reason}</p>)}<a href={receipt.captured.url} target="_blank" rel="noreferrer">Open exact PR ↗</a>
    <details><summary>Inspect complete receipt</summary><pre>{JSON.stringify(receipt, null, 2)}</pre></details>
  </AskSurface>
}
export function releaseActionTargets(pulls: ReleasePull[]) { return pulls.map(pull => ({ ...pull, base: 'main' })) }

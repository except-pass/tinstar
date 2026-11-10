import { useRef, useState } from 'react'
import { apiFetch } from '../apiClient'
import type { SceneCard } from '../server/reconciliation/scene'
import type { CreateWorkInput, StartWorkResult, UpdateWorkInput } from '../shared/workflow'

type WithoutOperation<T> = T extends unknown ? Omit<T, 'operation_id'> : never
const actions = [['edit', 'Edit / note'], ['assign', 'Assign / handoff'], ['checkpoint', 'Record checkpoint'], ['wait', 'Record wait'], ['request_decision', 'Request decision'], ['answer_decision', 'Answer decision'], ['complete', 'Complete'], ['park', 'Park']] as const
const ordinary = ['Name', 'Area', 'Priority', 'Sub-area', 'Attention', 'Initiative', 'Epic', 'Link', 'Due Date', 'Start Date', 'Next action'] as const
const saveMessage = (result: StartWorkResult) => `${result.outcome === 'saved' ? 'Saved.' : result.outcome === 'partially-saved' ? 'Partially saved.' : 'Not saved.'} ${result.message}${result.saved_fields.length ? ` Confirmed: ${result.saved_fields.join(', ')}.` : ''}`
function useWorkSave(onSaved: (result?: StartWorkResult) => Promise<void>) {
  const [busy, setBusy] = useState(false), [result, setResult] = useState<StartWorkResult | null>(null)
  const attempt = useRef<{ signature: string; input: unknown; id: string }>()
  async function save(operation: 'create' | 'update', values: Omit<CreateWorkInput, 'operation_id'> | WithoutOperation<UpdateWorkInput>) {
    const signature = JSON.stringify([operation, values])
    if (signature !== attempt.current?.signature) { const id = crypto.randomUUID(); attempt.current = { signature, id, input: { ...values, operation_id: id } } }
    setBusy(true); setResult(null)
    try {
      const response = await apiFetch('/api/reconciliation/workflow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1' }, body: JSON.stringify({ operation, input: attempt.current.input }) })
      const body = await response.json()
      if (!response.ok || !body.ok || !body.data) throw new Error('Workflow unavailable')
      setResult(body.data)
      if (body.data.outcome !== 'not-saved') await onSaved(body.data).catch(() => {})
    } catch { setResult({ outcome: 'partially-saved', code: 'response-unavailable', operation_id: attempt.current.id, saved_fields: [], message: 'Save unconfirmed. Refresh, then retry; this attempt will be reused.' }) }
    finally { setBusy(false) }
  }
  return { busy, result, save }
}
const field = (label: string, value: string, set: (value: string) => void, required = true, multiline = false) => <label>{label}{multiline ? <textarea required={required} maxLength={12000} value={value} onChange={e => set(e.target.value)} /> : <input required={required} value={value} onChange={e => set(e.target.value)} />}</label>

/** These forms collect consumer intent; the same backend policy serves MCP. */
export function WorkActions({ card, onSaved, sources = [] }: { card: SceneCard; sources?: Array<{ id: string; text: string }>; onSaved: (result?: StartWorkResult) => Promise<void> }) {
  const [kind, setKind] = useState<UpdateWorkInput['kind']>('edit')
  const [owner, setOwner] = useState(String(card.source.properties.Owner?.value ?? ''))
  const [status, setStatus] = useState('Queued'), [note, setNote] = useState('')
  const [property, setProperty] = useState<typeof ordinary[number]>('Name'), [value, setValue] = useState(''), [changeProperty, setChangeProperty] = useState(false)
  const [brief, setBrief] = useState(''), [acceptance, setAcceptance] = useState('')
  const [evidence, setEvidence] = useState(''), [nextAction, setNextAction] = useState(''), [appointment, setAppointment] = useState(''), [confirmation, setConfirmation] = useState('provisional')
  const [dependency, setDependency] = useState(''), [unblocks, setUnblocks] = useState(''), [followUp, setFollowUp] = useState('')
  const [requestId, setRequestId] = useState(''), [requestedFrom, setRequestedFrom] = useState('Will'), [action, setAction] = useState('Decision'), [resolvedWait, setResolvedWait] = useState(''), [legacyAction, setLegacyAction] = useState('')
  const { save, busy, result } = useWorkSave(onSaved)
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const base = { card_id: card.id }
    let input: WithoutOperation<UpdateWorkInput>
    if (kind === 'edit') {
      const propValue = ['Initiative', 'Epic'].includes(property) && card.source.properties[property]?.type === 'relation' ? value.split(',').map(v => v.trim()).filter(Boolean) : value
      input = { ...base, kind, ...(changeProperty ? { properties: { [property]: propValue }, expected: { [property]: card.source.properties[property]?.value ?? null } } : {}),
        ...(brief || acceptance ? { content: { ...(brief ? { brief } : {}), ...(acceptance ? { acceptance_criteria: acceptance } : {}) } } : {}), ...(note ? { note } : {}) } as UpdateWorkInput
    } else if (kind === 'assign') input = { ...base, kind, owner, status, ...(note ? { note } : {}) } as UpdateWorkInput
    else if (kind === 'checkpoint') input = { ...base, kind, checkpoint: { assessment: note, evidence, next_action: nextAction, next_check_in: appointment, confirmation } } as UpdateWorkInput
    else if (kind === 'wait') input = { ...base, kind, dependency, unblocks_when: unblocks, follow_up_by: followUp, ...(note ? { note } : {}) }
    else if (kind === 'request_decision') input = { ...base, kind, request_id: requestId, question: note, action, requested_from: requestedFrom }
    else if (kind === 'answer_decision') input = { ...base, kind, request_id: requestId, answer: note, next: { owner, status }, ...(resolvedWait ? { resolve_wait: resolvedWait } : {}), ...(legacyAction ? { legacy_action: legacyAction } : {}) } as UpdateWorkInput
    else if (kind === 'complete') input = { ...base, kind, disposition: note, evidence }
    else input = { ...base, kind, disposition: note, status: status === 'Archived' ? 'Archived' : 'Backlog' }
    await save('update', input)
  }
  return <details className="ov-start-work ov-work-actions"><summary>Update work</summary><form onSubmit={event => void submit(event)}>
    <label>Operation<select value={kind} onChange={e => { setKind(e.target.value as typeof kind); setStatus('Queued') }}>{actions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    {kind === 'edit' && <>
      <label><input type="checkbox" checked={changeProperty} onChange={e => setChangeProperty(e.target.checked)} /> Change an ordinary property</label>
      {changeProperty && <><label>Property<select value={property} onChange={e => setProperty(e.target.value as typeof property)}>{ordinary.map(name => <option key={name}>{name}</option>)}</select></label>{field('New value (relation IDs separated by commas)', value, setValue, false)}</>}
      {field('Brief (leave blank to preserve)', brief, setBrief, false, true)}{field('Acceptance criteria (leave blank to preserve)', acceptance, setAcceptance, false, true)}
    </>}
    {(kind === 'assign' || kind === 'answer_decision') && <>{field('Next owner', owner, setOwner)}<label>Next status<select value={status} onChange={e => setStatus(e.target.value)}><option>Queued</option><option>Todo</option><option>Backlog</option></select></label><p>Assignment to Firstmate queues work. Use Start work when a tracked worker is executing.</p></>}
    {kind === 'checkpoint' && <>{field('Evidence', evidence, setEvidence, true, true)}{field('Next action', nextAction, setNextAction, true, true)}{field('Next check-in (date or timestamp with timezone)', appointment, setAppointment)}<label>Appointment<select value={confirmation} onChange={e => setConfirmation(e.target.value)}><option value="provisional">Provisional</option><option value="owner-confirmed">Owner confirmed</option></select></label><p>Date-only means 9 AM Eastern. In Progress uses the board ceiling.</p></>}
    {kind === 'wait' && <>{field('Named dependency', dependency, setDependency, true, true)}{field('What unblocks it', unblocks, setUnblocks, true, true)}{field('Who follows up', followUp, setFollowUp)}</>}
    {(kind === 'request_decision' || kind === 'answer_decision') && field('Decision request ID', requestId, setRequestId)}
    {kind === 'request_decision' && <>{field('Requested from', requestedFrom, setRequestedFrom)}{field('Will action', action, setAction)}</>}
    {kind === 'answer_decision' && sources.length > 0 && <label>Existing request or source note<select value={requestId} onChange={event => setRequestId(event.target.value)}><option value="">Choose an existing source, or enter its ID above</option>{sources.map(source => { const request = source.text.split('\n').find(line => line.startsWith('Tin Star request: ')); let id = source.id; try { if (request) id = JSON.parse(request.slice('Tin Star request: '.length)).id } catch { /* show actual source ID */ } return <option key={source.id} value={id}>{source.text.split('\n').find(line => line.startsWith('Question: ')) ?? source.text.slice(0, 100)}</option> })}</select></label>}
    {kind === 'answer_decision' && field('Legacy action tag explicitly resolved (optional)', legacyAction, setLegacyAction, false)}
    {kind === 'answer_decision' && field('Exact wait text resolved (optional; preserves other waits)', resolvedWait, setResolvedWait, false, true)}
    {kind === 'complete' && field('Completion evidence', evidence, setEvidence, true, true)}
    {kind === 'park' && <label>Park status<select value={status === 'Archived' ? 'Archived' : 'Backlog'} onChange={e => setStatus(e.target.value)}><option>Backlog</option><option>Archived</option></select></label>}
    {field(kind === 'request_decision' ? 'Question' : kind === 'answer_decision' ? 'Answer' : kind === 'checkpoint' ? 'Assessment' : kind === 'complete' || kind === 'park' ? 'Supported disposition' : 'Note', note, setNote, !['edit', 'assign', 'wait'].includes(kind), true)}
    <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save update'}</button>
    {result && <p role="status" data-save-outcome={result.outcome}>{saveMessage(result)}</p>}
  </form></details>
}

export function CreateWork({ onSaved }: { onSaved: (result?: StartWorkResult) => Promise<void> }) {
  const [name, setName] = useState(''), [owner, setOwner] = useState(''), [area, setArea] = useState(''), [brief, setBrief] = useState(''), [acceptance, setAcceptance] = useState('')
  const { save, busy, result } = useWorkSave(onSaved)
  return <details className="ov-start-work ov-create-work"><summary>Create work</summary><form onSubmit={event => { event.preventDefault(); void save('create', { name, owner, area, status: 'Queued', content: { ...(brief ? { brief } : {}), ...(acceptance ? { acceptance_criteria: acceptance } : {}) } }) }}>
    {field('Card name', name, setName)}{field('Owner', owner, setOwner)}{field('Area', area, setArea)}{field('Brief', brief, setBrief, false, true)}{field('Acceptance criteria', acceptance, setAcceptance, false, true)}
    <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create queued card'}</button>{result && <p role="status" data-save-outcome={result.outcome}>{saveMessage(result)}</p>}
  </form></details>
}

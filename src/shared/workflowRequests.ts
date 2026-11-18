import { decisionProposalSchema } from './decisionProposal'
import { firstMateRequestSchema } from './deskSource'
import { decisionOptionsSchema } from './workflow'
import { workflowMarkers } from './workflowMarkers'

const withdrawalPrefix = `${workflowMarkers.withdrawal} `
const withdrawalOperation = (lines: string[]) => lines[2] === 'Operation: withdraw_decision' || lines[2] === 'Operation: supersede_decision'
export const isDecisionRetraction = (text: string) => withdrawalOperation(text.split('\n', 3))
/** Workflow history is evidence of a particular request, not an inference from
 * page edit time. Missing or partial history cannot establish that none exist. */
type WorkflowRecordSource = { text: string; type?: string; workflowWriter?: boolean }
export interface RequestNote extends WorkflowRecordSource { id: string; createdAt?: string | null; created_time?: string }
export const decisionRecordRows = (notes: WorkflowRecordSource[], prefix: string): ReturnType<typeof JSON.parse>[] => notes.flatMap(note => {
  const lines = note.text.split('\n')
  if (withdrawalOperation(lines)) {
    if (!note.workflowWriter || note.type !== 'comment') return []
    if (prefix !== withdrawalPrefix && prefix !== `${workflowMarkers.request} `) return []
    const footer = note.text.trimEnd().split('\n'), marker = footer.at(-2)
    const superseded = lines[2] === 'Operation: supersede_decision'
    // Only the fixed footer is a record. The reason and question may quote markers.
    if (!receiptIdentity(footer.at(-1)!) || !marker?.startsWith(withdrawalPrefix)) return []
    try {
      const { id, replacement } = JSON.parse(marker.slice(withdrawalPrefix.length))
      if (typeof id !== 'string' || !id || superseded && (typeof replacement?.id !== 'string' ||
        !replacement.id || replacement.id === id || typeof replacement.action !== 'string')) return []
      if (prefix === withdrawalPrefix) return [id]
      return superseded ? [replacement] : []
    } catch { return [] }
  }
  if (prefix === withdrawalPrefix) return []
  const recordStart = lines.findIndex(line => line.startsWith('Tin Star answer: ') || line.startsWith('Tin Star request: '))
  const operation = lines.slice(0, recordStart < 0 ? lines.length : recordStart).find(line => line.startsWith('Operation: '))
  if (prefix === 'Tin Star request: ' && operation === 'Operation: answer_decision') {
    const data = lines.filter(line => line.startsWith('Tin Star answer data: ')).at(-1)
    try { const row = data && JSON.parse(data.slice('Tin Star answer data: '.length)); return row?.binding ? [row.binding] : [] } catch { return [] }
  }
  const kind = prefix === 'Tin Star request: ' ? 'request_decision' : prefix === 'Tin Star answer: ' || prefix === 'Tin Star answer data: ' ? 'answer_decision' : null
  // Quoted protocol examples in an edit/comment are not a new owner decision.
  const legacyRequest = prefix === 'Tin Star request: ' && (lines[0]?.startsWith('Requested from: ') || lines[0]?.startsWith('Question: '))
  if (kind && (operation ? operation !== `Operation: ${kind}` : !legacyRequest && !lines[0]?.startsWith(prefix === 'Tin Star answer data: ' ? 'Tin Star answer: ' : prefix))) return []
  if (!kind && !lines[0]?.startsWith(prefix)) return []
  if (prefix === 'Tin Star answer: ') {
    const data = decisionRecordRows([note], 'Tin Star answer data: ')[0]
    if (data) return typeof data.request_id === 'string' ? [data.request_id] : []
  }
  const records = lines.filter(line => line.startsWith(prefix))
  return (kind === 'answer_decision' && prefix === 'Tin Star answer: ' ? records.slice(0, 1) : records.slice(-1)).flatMap(line => { try { return [JSON.parse(line.slice(prefix.length))] } catch { return [] } })
})
function receiptIdentity(terminal: string): boolean {
  if (!terminal.startsWith('Tin Star operation: ')) return false
  try {
    const identity: unknown = JSON.parse(terminal.slice('Tin Star operation: '.length))
    return Array.isArray(identity) && identity.length === 2 && identity.every(value => typeof value === 'string' && value.length > 0)
  } catch { return false }
}
export function workflowReceipt(note: WorkflowRecordSource): string | null {
  const lines = note.text.trimEnd().split('\n'), terminal = lines.at(-1)!
  if (!receiptIdentity(terminal)) return null
  if (withdrawalOperation(lines)) return decisionRecordRows([note], withdrawalPrefix).length ? terminal : null
  const answer = decisionRecordRows([note], 'Tin Star answer: ')[0]
  if (typeof answer === 'string') {
    const data = decisionRecordRows([note], 'Tin Star answer data: ')[0]
    if (data) {
      if (data.request_id !== answer || !lines.at(-2)?.startsWith('Tin Star answer data: ')) return null
    } else if (!/\nNext owner: [^\r\n]+\nNext status: [^\r\n]+(?:\nResolved wait: [^\r\n]+)?$/.test(lines.slice(0, -1).join('\n'))) return null
  }
  return terminal
}
export function workflowNoteHasMarker(note: WorkflowRecordSource, marker: string): boolean {
  return marker.startsWith('Tin Star operation: ') ? workflowReceipt(note) === marker : note.text.trimEnd().split('\n').at(-1) === marker
}
export const withdrawnDecisionIds = (notes: WorkflowRecordSource[]) => new Set<string>(decisionRecordRows(notes, withdrawalPrefix))

export function requestOwnedRestoredActions(notes: RequestNote[]) {
  const open = new Map<string, string>()
  const restored = new Set<string>()
  for (const note of notes) {
    const answers = decisionRecordRows([note], 'Tin Star answer: ')
    if (!answers.length) {
      for (const row of decisionRecordRows([note], 'Tin Star request: ')) {
        if (typeof row?.id !== 'string' || typeof row.action !== 'string') continue
        open.set(row.id, row.action)
        if (row.restored_action === true && isDecisionRetraction(note.text)) restored.add(row.action)
      }
    }
    for (const id of [...answers, ...withdrawnDecisionIds([note])]) {
      const action = open.get(id)
      open.delete(id)
      if (action !== undefined && ![...open.values()].includes(action)) restored.delete(action)
    }
  }
  return restored
}

export function decisionRequests(notes: RequestNote[]) {
  const answered = new Set<string>()
  for (const id of decisionRecordRows(notes, 'Tin Star answer: ')) answered.add(id)
  const withdrawn = withdrawnDecisionIds(notes)
  return notes.flatMap(note => decisionRecordRows([note], 'Tin Star request: ').flatMap(row => {
    try {
      if (typeof row.id !== 'string' || typeof row.action !== 'string' || withdrawn.has(row.id)) return []
      const options = decisionOptionsSchema.safeParse(row.options)
      const proposal = decisionProposalSchema.safeParse(row.proposal), sourceRequest = firstMateRequestSchema.safeParse(row.source_request)
      const lines = note.text.split('\n')
      const replacement = lines[2] === 'Operation: supersede_decision' && withdrawalOperation(lines)
      // Preserve incomplete fleet metadata so a broken binding cannot be
      // reinterpreted as an independent card-native decision.
      return [{ id: row.id as string, action: row.action as string, preserveAction: row.preserve_action === true, options: options.success ? options.data : undefined,
        ...(row.source_request != null || row.source_question != null || row.source_spawn_gen != null ? { hasSourceBinding: true } : {}),
        ...(proposal.success ? { proposal: proposal.data } : {}), ...(sourceRequest.success ? { sourceRequest: sourceRequest.data, sourceQuestion: row.source_question as string, sourceSpawnGen: row.source_spawn_gen as string | null } : {}),
        requestedFrom: replacement && typeof row.requested_from === 'string' ? row.requested_from : lines.find(line => line.startsWith('Requested from: '))?.slice('Requested from: '.length) ?? null,
        question: replacement && typeof row.question === 'string' ? row.question : lines.find(line => line.startsWith('Question: '))?.slice('Question: '.length) ?? null,
        since: note.createdAt ?? note.created_time ?? null, sourceId: note.id, answered: answered.has(row.id) }]
    } catch { return [] }
  }))
}

import { currentDecisionProposal, decisionProposalSchema, type DecisionProposal } from './decisionProposal'
import { firstMateRequestSchema, requestAnchor } from './deskSource'
import { decisionOptionsSchema } from './workflow'
/** Workflow history is evidence of a particular request, not an inference from
 * page edit time. Missing or partial history cannot establish that none exist. */
export interface RequestNote { id: string; text: string; type?: string; createdAt?: string | null; created_time?: string }
export const decisionRecordRows = (notes: { text: string }[], prefix: string): ReturnType<typeof JSON.parse>[] => notes.flatMap(note => {
  const lines = note.text.split('\n')
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
export function workflowReceipt(note: { text: string }): string | null {
  const lines = note.text.trimEnd().split('\n'), terminal = lines.at(-1)!
  if (!terminal.startsWith('Tin Star operation: ')) return null
  try {
    const identity: unknown = JSON.parse(terminal.slice('Tin Star operation: '.length))
    if (!Array.isArray(identity) || identity.length !== 2 || !identity.every(value => typeof value === 'string' && value.length > 0)) return null
  } catch { return null }
  const answer = decisionRecordRows([note], 'Tin Star answer: ')[0]
  if (typeof answer === 'string') {
    const data = decisionRecordRows([note], 'Tin Star answer data: ')[0]
    if (data) {
      if (data.request_id !== answer || !lines.at(-2)?.startsWith('Tin Star answer data: ')) return null
    } else if (!/\nNext owner: [^\r\n]+\nNext status: [^\r\n]+(?:\nResolved wait: [^\r\n]+)?$/.test(lines.slice(0, -1).join('\n'))) return null
  }
  return terminal
}
export function workflowNoteHasMarker(note: { text: string }, marker: string): boolean {
  return marker.startsWith('Tin Star operation: ') ? workflowReceipt(note) === marker : note.text.trimEnd().split('\n').at(-1) === marker
}

const noteTime = (note: RequestNote) => Date.parse(note.createdAt ?? note.created_time ?? '')
const operation = (note: RequestNote) => /^(?:Date: [^\n]+\nBy: [^\n]+\n)?Operation: (\w+)(?=\r?\n|$)/.exec(note.text)?.[1]
const timeOrdered = (a: RequestNote, b: RequestNote) => Number.isFinite(noteTime(a)) && Number.isFinite(noteTime(b))

export function ownerDecisionOperation(note: RequestNote) {
  if (note.type && note.type !== 'comment') return false
  const receipt = workflowReceipt(note)
  return !!receipt && operation(note) === 'answer_decision' && JSON.parse(receipt.slice('Tin Star operation: '.length))[0] === 'owner-chatgpt'
}

function ownerDecision(note: RequestNote) {
  if (note.type && note.type !== 'comment') return null
  const receipt = workflowReceipt(note)
  const connector = !!receipt && JSON.parse(receipt.slice('Tin Star operation: '.length))[0] === 'owner-chatgpt'
  const text = (receipt ? note.text.trimEnd().slice(0, -receipt.length) : note.text).trim()
  // A connector comment may wrap the same owner heading in workflow metadata.
  const body = connector ? text.replace(/^(?:Date: [^\n]+\nBy: [^\n]+\n)?Operation: (?:edit|comment)\r?\n/, '') : text
  if (receipt && !connector) return null
  const heading = /^OWNER DECISION (?:\(Will, [^\r\n]+?, via [^)\r\n]+\)|— [^:\r\n]+):/.exec(body)
  if (!heading) return null
  const payload = body.slice(heading[0].length).trim()
  const requestLine = /^Request ID:[ \t]*([^\r\n]+?)[ \t]*\r?$/m.exec(payload)
  const id = requestLine?.[1]?.trim().replace(/^(["`])(.+)\1$/, '$2')
  const answer = (requestLine ? payload.replace(requestLine[0], '') : payload).trim()
  return answer ? { id, answer } : null
}

function effectiveDecisionPublications<T extends { proposal?: unknown; source_request?: unknown }>(rows: T[], publications: { value: DecisionProposal }[] = []) {
  const groups = new Map<string, { row: T; value: DecisionProposal }[]>()
  const effective = new Set<T>()
  for (const row of rows) {
    const proposal = decisionProposalSchema.safeParse(row.proposal)
    if (!proposal.success) { effective.add(row); continue }
    const request = firstMateRequestSchema.safeParse(row.source_request)
    if (!request.success || proposal.data.source.kind !== 'firstmate-request' || proposal.data.source.id !== request.data.id) continue
    const key = requestAnchor(request.data)
    const group = groups.get(key) ?? []
    group.push({ row, value: proposal.data })
    groups.set(key, group)
  }
  for (const group of groups.values()) {
    const keys = new Set(group.map(entry => entry.value.request_key))
    const current = currentDecisionProposal<{ value: DecisionProposal }>([...group, ...publications.filter(entry => keys.has(entry.value.request_key))])
    const match = group.find(entry => JSON.stringify(entry.value) === JSON.stringify(current?.value))
    if (match) effective.add(match.row)
  }
  return rows.filter(row => effective.has(row))
}

interface DecisionRequestState<T extends RequestNote> {
  publication: T
  row: ReturnType<typeof JSON.parse>
  effective: boolean
  answers: T[]
  ownerAnswer?: { note: T; text: string }
  verification?: string
}

export function projectDecisionHistory<T extends RequestNote>(notes: T[], publications: { value: DecisionProposal }[] = []) {
  const ask = publications.filter(entry => entry.value.source.kind === 'ask-reply')
  const current = new Map<string, DecisionRequestState<T>>()
  let unmatchedOwnerDecision: string | undefined
  const structured = new Map<string, T[]>()
  const order = new Map(notes.map((note, index) => [note, index]))
  const ordered = [...notes].sort((a, b) => (noteTime(a) || 0) - (noteTime(b) || 0))
  const precedes = (a: T, b: T) => timeOrdered(a, b) && noteTime(a) !== noteTime(b)
    ? noteTime(a) < noteTime(b) : order.get(a)! < order.get(b)!
  for (const note of ordered) {
    const [row] = decisionRecordRows([note], 'Tin Star request: ')
    if (row && typeof row.id === 'string' && typeof row.action === 'string' && !current.has(row.id)) {
      current.set(row.id, { publication: note, row, effective: false, answers: [] })
    }
    const [id] = decisionRecordRows([note], 'Tin Star answer: ')
    if (typeof id === 'string') {
      const history = structured.get(id) ?? []
      history.push(note)
      structured.set(id, history)
      const request = current.get(id)
      if (request && (!timeOrdered(request.publication, note) || noteTime(request.publication) <= noteTime(note))) {
        request.answers.push(note)
        request.verification = undefined
      }
      continue
    }
    const decision = ownerDecision(note)
    if (!decision) continue
    const published = [...current.values()].filter(request => precedes(request.publication, note))
    const effective = new Set(effectiveDecisionPublications(published.map(request => request.row), ask.filter(entry => Date.parse(entry.value.published_at) <= noteTime(note))))
    const open = published.filter(request => effective.has(request.row) && !request.answers.length)
    const matches = decision.id ? open.filter(request => request.row.id === decision.id) : open
    if (matches.length !== 1) {
      const message = matches.length ? 'Owner decision matches multiple open requests. Verify its request ID.'
        : 'Owner decision does not match an open request. Verify its request ID.'
      if (!open.length && !published.some(request => request.answers.length && (!decision.id || request.row.id === decision.id))) unmatchedOwnerDecision = message
      for (const request of open) request.verification = message
      continue
    }
    const request = matches[0]!
    unmatchedOwnerDecision = undefined
    request.answers.push(note)
    request.ownerAnswer = { note, text: decision.answer }
    request.verification = undefined
  }
  const effective = new Set(effectiveDecisionPublications([...current.values()].map(request => request.row), ask))
  for (const request of current.values()) {
    request.effective = effective.has(request.row)
    // Older structured receipts may have no provider time or may be returned
    // before a body publication. They still bind by their explicit request ID.
    for (const answer of structured.get(request.row.id) ?? []) {
      if (!request.answers.includes(answer) && !timeOrdered(request.publication, answer)) request.answers.push(answer)
    }
  }
  return { requests: current, unmatchedOwnerDecision }
}

export function decisionRequests(notes: RequestNote[], states = projectDecisionHistory(notes).requests) {
  return notes.flatMap(note => decisionRecordRows([note], 'Tin Star request: ').flatMap(row => {
    try {
      if (typeof row.id !== 'string' || typeof row.action !== 'string') return []
      const state = states.get(row.id)!
      if (state.publication !== note) return []
      const options = decisionOptionsSchema.safeParse(row.options)
      const proposal = decisionProposalSchema.safeParse(row.proposal), sourceRequest = firstMateRequestSchema.safeParse(row.source_request)
      const lines = note.text.split('\n')
      // Preserve incomplete fleet metadata so a broken binding cannot be
      // reinterpreted as an independent card-native decision.
      return [{ id: row.id as string, action: row.action as string, preserveAction: row.preserve_action === true, options: options.success ? options.data : undefined,
        ...(row.source_request != null || row.source_question != null || row.source_spawn_gen != null ? { hasSourceBinding: true } : {}),
        ...(proposal.success ? { proposal: proposal.data } : {}), ...(sourceRequest.success ? { sourceRequest: sourceRequest.data, sourceQuestion: row.source_question as string, sourceSpawnGen: row.source_spawn_gen as string | null } : {}),
        requestedFrom: lines.find(line => line.startsWith('Requested from: '))?.slice('Requested from: '.length) ?? null,
        question: lines.find(line => line.startsWith('Question: '))?.slice('Question: '.length) ?? null,
        since: note.createdAt ?? note.created_time ?? null, sourceId: note.id, ...(!state.effective ? { superseded: true as const } : {}), answered: state.answers.length > 0,
        ...(state.ownerAnswer || state.answers.some(ownerDecisionOperation) ? { answeredByOwner: true } : {}),
        ...(state.verification ? { verification: state.verification } : {}) }]
    } catch { return [] }
  }))
}

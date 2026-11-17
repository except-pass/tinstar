import { decisionProposalSchema } from './decisionProposal'
import { firstMateRequestSchema } from './deskSource'
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
  const heading = /^OWNER DECISION[ \t]*\((Will(?=[ \t,)])[^)\r\n]*)\)[ \t]*:?[ \t]*/i.exec(body)
  const payload = heading ? body.slice(heading[0].length).trim() : body
  const requestLine = /^(?:(?:Decision )?request[ _]id|Decision request|Tin Star decision):[ \t]*([^\r\n]+?)[ \t]*\r?$/im.exec(payload)
  const inlineId = /(?:^|,)\s*request[ _]id:\s*([^,]+)\s*$/i.exec(heading?.[1] ?? '')?.[1]
  const id = (requestLine?.[1] ?? inlineId)?.trim().replace(/^(["`])(.+)\1$/, '$2')
  if (heading) {
    const answer = (requestLine ? payload.replace(requestLine[0], '') : payload).trim()
    return answer ? { id, answer, optionId: undefined } : null
  }
  if (!connector || operation(note) !== 'answer_decision' || !id) return null
  const optionId = /^Option(?:[ _]id)?:[ \t]*([^\r\n]+)/im.exec(payload)?.[1]?.trim().replace(/^(["`])(.+)\1$/, '$2')
  if (!optionId) return null
  const answer = /(?:^|\n)Answer: ([\s\S]*?)(?=\n(?:Next owner|Next status|Option(?:[ _]id)?):|$)/i.exec(payload)?.[1]?.trim()
  return { id, answer: answer || optionId, optionId }
}

interface DecisionRequestState<T extends RequestNote> {
  publication: T
  row: ReturnType<typeof JSON.parse>
  answers: T[]
  ownerAnswer?: { note: T; text: string }
  verification?: string
  reopened: boolean
}

/** Resolve the current request from the card's own history. A same-ID
 * publication can reopen only after an observed answer and a new workflow
 * request. Existing binding addenda and legacy answers remain readable. */
export function decisionRequestStates<T extends RequestNote>(notes: T[]) {
  const current = new Map<string, DecisionRequestState<T>>()
  const structured = new Map<string, T[]>()
  const order = new Map(notes.map((note, index) => [note, index]))
  const ordered = [...notes].sort((a, b) => (noteTime(a) || 0) - (noteTime(b) || 0))
  const precedes = (a: T, b: T) => timeOrdered(a, b) && noteTime(a) !== noteTime(b)
    ? noteTime(a) < noteTime(b) : order.get(a)! < order.get(b)!
  for (const note of ordered) {
    const [row] = decisionRecordRows([note], 'Tin Star request: ')
    if (row && typeof row.id === 'string' && typeof row.action === 'string') {
      const prior = current.get(row.id)
      const reopened = !!prior && prior.answers.length > 0 && operation(note) === 'request_decision' &&
        precedes(prior.publication, note) && prior.answers.every(answer => precedes(answer, note))
      if (!prior || reopened) current.set(row.id, { publication: note, row, answers: [], reopened })
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
    const open = [...current.values()].filter(request => precedes(request.publication, note) && !request.answers.length)
    const matches = decision.id ? open.filter(request => request.row.id === decision.id) : open
    if (matches.length > 1) {
      for (const request of matches) request.verification = 'Owner decision matches multiple open requests. Verify its request ID.'
      continue
    }
    const [request] = matches
    if (!request) continue
    if (decision.optionId && !decisionOptionsSchema.safeParse(request.row.options).data?.some(option => option.id === decision.optionId)) {
      request.verification = 'Owner decision names an option that is not recorded on this request'
      continue
    }
    request.answers.push(note)
    request.ownerAnswer = { note, text: decision.answer }
    request.verification = undefined
  }
  for (const request of current.values()) {
    // Older structured receipts may have no provider time or may be returned
    // before a body publication. They still bind by their explicit request ID.
    for (const answer of structured.get(request.row.id) ?? []) {
      if (!request.reopened && !request.answers.includes(answer) && !timeOrdered(request.publication, answer)) request.answers.push(answer)
    }
  }
  return current
}

export function decisionCycleNotes<T extends RequestNote>(notes: T[], requestId: string) {
  const request = decisionRequestStates(notes).get(requestId)
  if (!request?.reopened) return notes
  const start = notes.indexOf(request.publication)
  return notes.filter((note, index) => timeOrdered(request.publication, note) && noteTime(note) !== noteTime(request.publication)
    ? noteTime(note) > noteTime(request.publication) : index >= start)
}

export function decisionRequests(notes: RequestNote[]) {
  const states = decisionRequestStates(notes)
  return notes.flatMap(note => decisionRecordRows([note], 'Tin Star request: ').flatMap(row => {
    try {
      if (typeof row.id !== 'string' || typeof row.action !== 'string') return []
      const state = states.get(row.id)!
      if (state.reopened && state.publication !== note) return []
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
        since: note.createdAt ?? note.created_time ?? null, sourceId: note.id, answered: state.answers.length > 0,
        ...(state.ownerAnswer ? { answer: state.ownerAnswer.text } : {}),
        ...(state.ownerAnswer || state.answers.some(ownerDecisionOperation) ? { answeredByOwner: true } : {}),
        ...(state.verification ? { verification: state.verification } : {}) }]
    } catch { return [] }
  }))
}

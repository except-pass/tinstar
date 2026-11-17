import { currentDecisionProposal, decisionProposalSchema, type DecisionProposal } from './decisionProposal'
import { firstMateRequestSchema } from './deskSource'
import { decisionOptionsSchema } from './workflow'
/** Workflow history is evidence of a particular request, not an inference from
 * page edit time. Missing or partial history cannot establish that none exist. */
export interface RequestNote { id: string; text: string; type?: string; createdAt?: string | null; created_time?: string }
export const decisionRecordRows = (notes: { text: string }[], prefix: string, strict = false): ReturnType<typeof JSON.parse>[] => notes.flatMap(note => {
  const lines = note.text.split('\n')
  const recordStart = lines.findIndex(line => line.startsWith('Tin Star answer: ') || line.startsWith('Tin Star request: '))
  const operation = lines.slice(0, recordStart < 0 ? lines.length : recordStart).find(line => line.startsWith('Operation: '))
  if (prefix === 'Tin Star request: ' && operation === 'Operation: answer_decision') {
    const data = lines.filter(line => line.startsWith('Tin Star answer data: ')).at(-1)
    try { const row = data && JSON.parse(data.slice('Tin Star answer data: '.length)); return row?.binding ? [row.binding] : [] } catch (error) { if (strict) throw error; return [] }
  }
  const kind = prefix === 'Tin Star request: ' ? 'request_decision' : prefix === 'Tin Star answer: ' || prefix === 'Tin Star answer data: ' ? 'answer_decision' : null
  // Quoted protocol examples in an edit/comment are not a new owner decision.
  const legacyRequest = prefix === 'Tin Star request: ' && (lines[0]?.startsWith('Requested from: ') || lines[0]?.startsWith('Question: '))
  if (kind && (operation ? operation !== `Operation: ${kind}` : !legacyRequest && !lines[0]?.startsWith(prefix === 'Tin Star answer data: ' ? 'Tin Star answer: ' : prefix))) return []
  if (!kind && !lines[0]?.startsWith(prefix)) return []
  if (prefix === 'Tin Star answer: ') {
    const data = decisionRecordRows([note], 'Tin Star answer data: ', strict)[0]
    if (data) return typeof data.request_id === 'string' ? [data.request_id] : []
  }
  const records = lines.filter(line => line.startsWith(prefix))
  return (kind === 'answer_decision' && prefix === 'Tin Star answer: ' ? records.slice(0, 1) : records.slice(-1)).flatMap(line => { try { return [JSON.parse(line.slice(prefix.length))] } catch (error) { if (strict) throw error; return [] } })
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
  const requestLine = /^Request ID:[ \t]*([^\r\n]*?)[ \t]*\r?$/m.exec(payload)
  const id = requestLine?.[1]?.trim()
  const answer = (requestLine ? payload.replace(requestLine[0], '') : payload).trim()
  return answer ? { id, answer } : null
}

type DecisionPublication = { value: DecisionProposal; answer_id?: string; anchor?: string | null }

export const completeDecisionHistory = (history?: { outcome: string; commentsOutcome?: string }) =>
  history?.outcome === 'available' && history.commentsOutcome === 'available'

export function cardDecisionPublications(notes: RequestNote[], publications: DecisionPublication[], cardId: string) {
  const keys = new Set(decisionRecordRows(notes, 'Tin Star request: ').map(row => row?.proposal?.request_key))
  return publications.filter(entry => entry.value.card_id === cardId || entry.anchor === cardId || keys.has(entry.value.request_key))
}

function decisionReplacements(rows: ReturnType<typeof JSON.parse>[]) {
  const groups = new Map<string, { id: string; value: DecisionProposal }[]>()
  for (const row of rows) {
    if (!row.proposal) continue
    const value = decisionProposalSchema.parse(row.proposal)
    const group = groups.get(value.request_key) ?? []
    group.push({ id: row.id, value })
    groups.set(value.request_key, group)
  }
  const replacements = new Map<string, string>()
  for (const group of groups.values()) {
    const current = currentDecisionProposal(group)
    if (!current) throw new Error('Decision publication history is contradictory or incomplete')
    for (const entry of group) if (entry.id !== current.id) replacements.set(entry.id, current.id)
  }
  return replacements
}

interface DecisionRequestState<T extends RequestNote> {
  publication: RequestNote
  row: ReturnType<typeof JSON.parse>
  effective: boolean
  supersededBy?: string
  answers: T[]
  ownerAnswer?: { note: T; text: string }
  verification?: string
}

export function projectDecisionHistory<T extends RequestNote>(notes: T[], publications: DecisionPublication[] = [], complete = true) {
  const ask = [...new Map(publications.filter(entry => entry.value.source.kind === 'ask-reply').map(entry => [entry.answer_id ?? entry.value.source.id, entry.value])).entries()]
  const askStates = ask.map(([id, proposal]) => ({
    publication: { id, text: 'Requested from: Will', createdAt: proposal.published_at },
    row: { id, action: 'Decision', proposal, ask: true }, effective: false, answers: [] as T[],
  }))
  const current = new Map<string, DecisionRequestState<T>>()
  let unmatchedOwnerDecision: string | undefined
  const structured = new Map<string, T[]>()
  const order = new Map<RequestNote, number>(notes.map((note, index) => [note, index]))
  const ordered = [...notes].sort((a, b) => (noteTime(a) || 0) - (noteTime(b) || 0))
  const precedes = (a: RequestNote, b: RequestNote) => timeOrdered(a, b) && noteTime(a) !== noteTime(b)
    ? noteTime(a) < noteTime(b) : order.get(a)! < order.get(b)!
  let verification = complete ? undefined : 'Complete decision history is unavailable. Verify the open requests.'
  let replacements = new Map<string, string>()
  const entries = ordered.flatMap(note => {
    try {
      const rows = decisionRecordRows([note], 'Tin Star request: ', complete)
      if (complete) decisionRecordRows([note], 'Tin Star answer: ', true)
      return rows.map(row => ({ note, row, binding: decisionRecordRows([note], 'Tin Star answer data: ')[0] }))
    } catch {
      verification = 'Decision publication history is contradictory or incomplete'
      return []
    }
  })
  const publicationsById = new Map<string, typeof entries>()
  for (const entry of entries) {
    const group = publicationsById.get(entry.row?.id) ?? []
    group.push(entry)
    publicationsById.set(entry.row?.id, group)
  }
  const cardRows = new Map<RequestNote, ReturnType<typeof JSON.parse>>()
  for (const group of publicationsById.values()) {
    const original = group.filter(entry => !entry.binding?.binding)
    const added = group.filter(entry => entry.binding?.binding)
    const publication = original[0] ?? added[0]!
    const { row } = publication
    if (complete && (typeof row?.id !== 'string' || typeof row.action !== 'string' ||
      original.length > 1 || added.length > 1 || added.some(entry => entry.binding.request_id !== row.id) ||
      original.length && added.length && (row.source_request || !added[0]!.row.source_request ||
        row.action !== added[0]!.row.action || row.preserve_action !== added[0]!.row.preserve_action) ||
      row.source_request && !firstMateRequestSchema.safeParse(row.source_request).success ||
      row.proposal && (!firstMateRequestSchema.safeParse(row.source_request).success ||
        row.proposal.source?.kind !== 'firstmate-request' || row.proposal.source?.id !== row.source_request.id ||
        row.source_request_key !== undefined && row.source_request_key !== row.proposal.request_key))) {
      verification = 'Decision publication history is contradictory or incomplete'
    }
    cardRows.set(publication.note, row)
  }
  if (!verification) try {
    if (askStates.some(state => publicationsById.has(state.row.id))) throw new Error('Duplicate publication')
    replacements = decisionReplacements([...cardRows.values(), ...askStates.map(state => state.row)])
  } catch { verification = 'Decision publication history is contradictory or incomplete' }
  for (const state of askStates) current.set(state.row.id, state)
  for (const note of ordered) {
    const row = cardRows.get(note)
    if (row && typeof row.id === 'string' && typeof row.action === 'string' && !current.has(row.id)) {
      current.set(row.id, { publication: note, row, effective: false, answers: [] })
    }
    if (verification) continue
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
    if (ask.length && !Number.isFinite(noteTime(note))) {
      unmatchedOwnerDecision = 'Owner decision time is unavailable. Verify the open requests.'
      continue
    }
    let replaced: Map<string, string>
    try { replaced = decisionReplacements(published.map(request => request.row)) }
    catch { unmatchedOwnerDecision = 'Decision publication history is contradictory or incomplete'; continue }
    const open = published.filter(request => !replaced.has(request.row.id) && !request.answers.length)
    const matches = decision.id !== undefined ? open.filter(request => request.row.id === decision.id) : open
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
  for (const request of current.values()) {
    request.supersededBy = replacements.get(request.row.id)
    request.effective = !verification && !request.supersededBy
    // Older structured receipts may have no provider time or may be returned
    // before a body publication. They still bind by their explicit request ID.
    for (const answer of structured.get(request.row.id) ?? []) {
      if (!request.answers.includes(answer) && !timeOrdered(request.publication, answer)) request.answers.push(answer)
    }
  }
  return { requests: current, unmatchedOwnerDecision, verification }
}

export function decisionRequests(notes: RequestNote[], states = projectDecisionHistory(notes).requests) {
  return [...states.values()].flatMap(state => {
    try {
      const { row, publication: note } = state
      const options = decisionOptionsSchema.safeParse(row.options)
      const proposal = decisionProposalSchema.safeParse(row.proposal), sourceRequest = firstMateRequestSchema.safeParse(row.source_request)
      const lines = note.text.split('\n')
      // Preserve incomplete fleet metadata so a broken binding cannot be
      // reinterpreted as an independent card-native decision.
      return [{ id: row.id as string, action: row.action as string, preserveAction: row.preserve_action === true, options: options.success ? options.data : undefined,
        ...(row.source_request != null || row.source_question != null || row.source_spawn_gen != null ? { hasSourceBinding: true } : {}),
        ...(proposal.success && !row.ask ? { proposal: proposal.data } : {}), ...(row.ask ? { askRequestKey: proposal.data?.request_key } : {}), ...(sourceRequest.success ? { sourceRequest: sourceRequest.data, sourceQuestion: row.source_question as string, sourceSpawnGen: row.source_spawn_gen as string | null } : {}),
        requestedFrom: lines.find(line => line.startsWith('Requested from: '))?.slice('Requested from: '.length) ?? null,
        question: lines.find(line => line.startsWith('Question: '))?.slice('Question: '.length) ?? null,
        since: note.createdAt ?? note.created_time ?? null, sourceId: note.id, ...(state.supersededBy ? { superseded: true as const } : {}), answered: state.answers.length > 0,
        ...(state.ownerAnswer || state.answers.some(ownerDecisionOperation) ? { answeredByOwner: true } : {}),
        ...(state.verification ? { verification: state.verification } : {}) }]
    } catch { return [] }
  })
}

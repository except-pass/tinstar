import { decisionOptionsSchema } from './workflow'
/** Workflow history is evidence of a particular request, not an inference from
 * page edit time. Missing or partial history cannot establish that none exist. */
export interface RequestNote { id: string; text: string; createdAt?: string | null; created_time?: string }
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
export function decisionRequests(notes: RequestNote[]) {
  const answered = new Set<string>()
  for (const id of decisionRecordRows(notes, 'Tin Star answer: ')) answered.add(id)
  return notes.flatMap(note => decisionRecordRows([note], 'Tin Star request: ').flatMap(row => {
    try {
      if (typeof row.id !== 'string' || typeof row.action !== 'string') return []
      const options = decisionOptionsSchema.safeParse(row.options)
      const lines = note.text.split('\n')
      return [{ id: row.id as string, action: row.action as string, preserveAction: row.preserve_action === true, options: options.success ? options.data : undefined,
        requestedFrom: lines.find(line => line.startsWith('Requested from: '))?.slice('Requested from: '.length) ?? null,
        question: lines.find(line => line.startsWith('Question: '))?.slice('Question: '.length) ?? null,
        since: note.createdAt ?? note.created_time ?? null, sourceId: note.id, answered: answered.has(row.id) }]
    } catch { return [] }
  }))
}

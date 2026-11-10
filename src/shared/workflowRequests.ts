import { decisionOptionsSchema } from './workflow'
/** Workflow history is evidence of a particular request, not an inference from
 * page edit time. Missing or partial history cannot establish that none exist. */
export interface RequestNote { id: string; text: string; createdAt?: string | null; created_time?: string }
export function decisionRequests(notes: RequestNote[]) {
  const answered = new Set<string>()
  for (const note of notes) for (const line of note.text.split('\n')) {
    if (!line.startsWith('Tin Star answer: ')) continue
    try { const id = JSON.parse(line.slice('Tin Star answer: '.length)); if (typeof id === 'string') answered.add(id) } catch { /* legacy prose remains source context */ }
  }
  return notes.flatMap(note => note.text.split('\n').flatMap(line => {
    if (!line.startsWith('Tin Star request: ')) return []
    try {
      const row = JSON.parse(line.slice('Tin Star request: '.length))
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

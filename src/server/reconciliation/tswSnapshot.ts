import { parseDispatchProvenance, type DispatchProvenance } from './dispatchProvenance'
import { tswKey } from './tswIdentity'
import { record, text } from './values'

export { tswKey, tswProjectId } from './tswIdentity'
export const tswEvidence = Symbol('TSW status evidence')
type Evidence = {
  dispatchProvenance: DispatchProvenance
  completion: string | null
  completedOn: string | null
  merged: boolean
  pull: string | null
  yolo: 'on' | 'off' | null
}

/** Collect only the status coordinator's source fields, without publishing note bodies. */
export function tswSnapshot(row: Record<string, unknown>, source: string, yolo?: unknown): { [tswEvidence]?: Evidence } {
  const completion = record(row.completion)
  return { [tswEvidence]: {
    dispatchProvenance: parseDispatchProvenance(row.body_lines, source, tswKey),
    completion: text(completion.verb),
    completedOn: text(completion.date),
    merged: row.merged === true,
    pull: text(row.pr_url),
    yolo: yolo === 'on' || yolo === 'off' ? yolo : null,
  } }
}

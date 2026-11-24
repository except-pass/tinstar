import { parseDispatchProvenance, type DispatchProvenance } from './dispatchProvenance'
import { record, text } from './values'

export const tswProjectId = '10639'
export const tswKey = (value: string) => /^TSW-[1-9]\d*$/.test(value) ? value : null
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

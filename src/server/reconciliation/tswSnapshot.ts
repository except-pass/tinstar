import { parseDispatchProvenance, type DispatchProvenance } from './dispatchProvenance'

export const tswKey = (value: string) => /^TSW-[1-9]\d*$/.test(value) ? value : null
export const tswEvidence = Symbol('TSW status evidence')

export function tswSnapshot(row: Record<string, unknown>, source: string): { [tswEvidence]?: { dispatchProvenance: DispatchProvenance } } {
  return { [tswEvidence]: { dispatchProvenance: parseDispatchProvenance(row.body_lines, source, tswKey) } }
}

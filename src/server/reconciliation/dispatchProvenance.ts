import { notionPageId } from './notion'

export type DispatchProvenance = { status: 'card'; cardId: string; sources: string[] } |
  { status: 'independent' | 'conflict' | 'absent'; sources: string[] }

/** Only the coordinator-authored backlog line is authority. Never retain prose. */
export function parseDispatchProvenance(lines: unknown, source = 'backlog.body_lines'): DispatchProvenance {
  if (lines === undefined) return { status: 'absent', sources: [] }
  if (!Array.isArray(lines) || !lines.every(line => typeof line === 'string')) return { status: 'conflict', sources: [source] }
  const declarations = lines.flatMap(line => line.split('\n')).map(line => line.replace(/\r$/, ''))
    .filter(line => /^\s*card\s*:/.test(line))
  if (!declarations.length) return { status: 'absent', sources: [] }
  if (declarations.length !== 1) return { status: 'conflict', sources: [source] }
  const line = declarations[0]!
  if (line === 'card: none') return { status: 'independent', sources: [source] }
  const id = line.startsWith('card: ') ? notionPageId(line.slice(6)) : null
  return id ? { status: 'card', cardId: id, sources: [source] } : { status: 'conflict', sources: [source] }
}

/** Snapshots may publish the same note under task.backlog and backlog.records. */
export function dispatchForTask(task: { dispatchProvenance?: DispatchProvenance }, backlog?: { dispatchProvenance?: DispatchProvenance }): DispatchProvenance {
  const values = [task.dispatchProvenance, backlog?.dispatchProvenance].filter((p): p is DispatchProvenance => !!p && p.status !== 'absent')
  const sources = [...new Set(values.flatMap(p => p.sources))].sort()
  if (!values.length) return { status: 'absent', sources }
  const first = values[0]!
  if (values.some(p => p.status === 'conflict' || p.status !== first.status || p.status === 'card' && first.status === 'card' && p.cardId !== first.cardId)) {
    return { status: 'conflict', sources }
  }
  return { ...first, sources }
}

export function collectedDispatch(row: Record<string, unknown>, source: string): { dispatchProvenance?: DispatchProvenance } {
  return { dispatchProvenance: parseDispatchProvenance(row.body_lines, source) }
}

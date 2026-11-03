import { record, text } from './values'

export interface QueueSignals {
  decisions: Array<{ key: string | null; verb: 'needs-decision' | 'blocked'; summary: string | null }>
  holdKind: string | null
  originTaskId: string | null
  completed: boolean
}

/** Only published attention metadata; never expose raw briefs or backlog bodies. */
export function queueSignals(value: Record<string, unknown>): { queue?: QueueSignals } {
  const entries = record(value.hints).open_decisions
  const lines = Array.isArray(value.body_lines) ? value.body_lines : []
  const origin = lines.flatMap(line => typeof line === 'string' ? /^Origin:\s*(\S+)$/.exec(line.trim())?.slice(1) ?? [] : [])[0]
  return { queue: {
    decisions: (Array.isArray(entries) ? entries : []).flatMap(entry => {
      const item = record(entry)
      return item.verb === 'needs-decision' || item.verb === 'blocked'
        ? [{ key: text(item.key), verb: item.verb, summary: text(item.summary) }] : []
    }),
    holdKind: text(value.hold_kind), originTaskId: origin ?? null,
    completed: value.merged === true || ['done', 'merged', 'completed', 'resolved', 'answered'].includes(String(record(value.completion).verb)),
  } }
}

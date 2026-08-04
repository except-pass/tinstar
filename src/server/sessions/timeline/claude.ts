import { readFileSync } from 'node:fs'
import { classifyClaudeCall, closeUnmatched, type PendingCall } from './classify'
import { idleIntervals, buildTurns, secOf, plausibleTime, type ParseResult } from './codex'
import type { Interval, Mark } from './types'

/** Flatten a tool_result's content — string, or an array of text blocks — to plain text. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(b => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
        ? (b as { text: string }).text
        : ''))
      .join('\n')
  }
  return ''
}

/** Claude Code JSONL → intervals, marks and turn boundaries. */
export function readClaudeTranscript(path: string, now = Date.now() / 1000): ParseResult {
  const entries: { t: number; o: Record<string, unknown> }[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try { o = JSON.parse(line) as Record<string, unknown> } catch { continue }
    // A sub-agent's own lines land in the parent's file. The parent's Agent tool
    // span already covers that stretch of time; counting both double-counts it.
    if (o.isSidechain) continue
    const t = secOf(o.timestamp)
    if (t === null || !plausibleTime(t, now)) continue
    entries.push({ t, o })
  }
  entries.sort((a, b) => a.t - b.t)

  const pending = new Map<string, PendingCall>()
  const intervals: Interval[] = []
  const marks: Mark[] = []
  const humans: number[] = []
  const ends: number[] = []
  let lastAssistant: number | null = null

  for (const { t, o } of entries) {
    const msg = (o.message ?? {}) as Record<string, unknown>
    const blocks = Array.isArray(msg.content) ? msg.content as Record<string, unknown>[] : []

    if (o.type === 'assistant') {
      lastAssistant = t
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          pending.set(String(b.id), {
            start: t,
            name: String(b.name ?? 'tool'),
            args: JSON.stringify(b.input ?? {}).slice(0, 200),
          })
        }
      }
    } else if (o.type === 'user') {
      const results = blocks.filter(b => b.type === 'tool_result')
      if (results.length > 0) {
        // A user entry carrying tool results is machinery, not a human turn.
        for (const b of results) {
          const call = pending.get(String(b.tool_use_id))
          if (!call) continue
          pending.delete(String(b.tool_use_id))
          // Decoded text, not JSON.stringify — the rejection check anchors at
          // the start of the real message, and a stringified blob buries it
          // behind quotes and block wrappers.
          const text = textOf(b.content).slice(0, 600)
          intervals.push(classifyClaudeCall(call.start, t, call.name, call.args, text, Boolean(b.is_error)))
          if (b.is_error) {
            marks.push({
              at: t,
              kind: 'tool-failed',
              name: call.name,
              detail: text.replace(/\s+/g, ' ').slice(0, 110),
            })
          }
        }
      } else {
        if (lastAssistant !== null) ends.push(lastAssistant)
        humans.push(t)
      }
    }
  }

  const t0 = entries.length > 0 ? entries[0]!.t : null
  const t1 = entries.length > 0 ? entries[entries.length - 1]!.t : null
  intervals.push(...closeUnmatched([...pending.values()], entries.map(e => e.t), now))
  if (t1 !== null) intervals.push(...idleIntervals(humans, ends, t1))
  return { intervals, marks, turns: buildTurns(humans, ends, t1), t0, t1 }
}

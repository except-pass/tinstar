import { readFileSync } from 'node:fs'
import { classifyClaudeCall } from './classify'
import {
  newReaderState, noteEntry, finishState, secOf, plausibleTime,
  type ParseResult, type ReaderState,
} from './shared'

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

/** Interpret one Claude Code transcript entry into accumulated state. */
export function feedClaudeEntry(state: ReaderState, t: number, o: Record<string, unknown>): void {
  noteEntry(state, t)
  const msg = (o.message ?? {}) as Record<string, unknown>
  const blocks = Array.isArray(msg.content) ? msg.content as Record<string, unknown>[] : []

  if (o.type === 'assistant') {
    state.lastAssistant = t
    for (const b of blocks) {
      if (b.type === 'tool_use') {
        state.pending.set(String(b.id), {
          start: t,
          name: String(b.name ?? 'tool'),
          args: JSON.stringify(b.input ?? {}).slice(0, 200),
        })
      }
    }
    return
  }

  if (o.type !== 'user') return

  const results = blocks.filter(b => b.type === 'tool_result')
  if (results.length === 0) {
    // A user entry with no tool results is a human turn.
    if (state.lastAssistant !== null) state.ends.push(state.lastAssistant)
    state.humans.push(t)
    return
  }

  // A user entry carrying tool results is machinery, not a human turn.
  for (const b of results) {
    const call = state.pending.get(String(b.tool_use_id))
    if (!call) continue
    state.pending.delete(String(b.tool_use_id))
    // Decoded text, not JSON.stringify — the rejection check anchors at the
    // start of the real message, and a stringified blob buries it behind
    // quotes and block wrappers.
    const text = textOf(b.content).slice(0, 600)
    state.intervals.push(classifyClaudeCall(call.start, t, call.name, call.args, text, Boolean(b.is_error)))
    if (b.is_error) {
      state.marks.push({
        at: t,
        kind: 'tool-failed',
        name: call.name,
        detail: text.replace(/\s+/g, ' ').slice(0, 110),
      })
    }
  }
}

/** True for entries that must not be fed to the reader at all. */
export function skipClaudeEntry(o: Record<string, unknown>): boolean {
  // A sub-agent's own lines land in the parent's file. The parent's Agent tool
  // span already covers that stretch of time; counting both double-counts it.
  return Boolean(o.isSidechain)
}

/**
 * Whole-file convenience read. The live path in index.ts feeds lines
 * incrementally instead; this exists for tests and one-off scripts.
 */
export function readClaudeTranscript(path: string, now = Date.now() / 1000): ParseResult {
  const state = newReaderState()
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try { o = JSON.parse(line) as Record<string, unknown> } catch { continue }
    if (skipClaudeEntry(o)) continue
    const t = secOf(o.timestamp)
    if (t === null || !plausibleTime(t, now)) continue
    feedClaudeEntry(state, t, o)
  }
  return finishState(state, now)
}

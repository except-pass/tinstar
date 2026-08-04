import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { classifyCodexCall } from './classify'
import {
  newReaderState, noteEntry, finishState, secOf, plausibleTime, snip,
  type ParseResult, type ReaderState,
} from './shared'

export type { ParseResult } from './shared'
export { secOf, plausibleTime, idleIntervals, buildTurns } from './shared'

/**
 * The only trustworthy failure signal. The words "error" and "failed" appear in
 * roughly 1,800 tool outputs in the measured corpus — nearly all of them grep
 * hits and test summaries — so matching on them would bury the real failures
 * rather than surface them (R12).
 */
const EXIT_RE = /Process exited with code (\d+)/g

/** Interpret one Codex rollout entry into accumulated state. */
export function feedCodexEntry(state: ReaderState, t: number, o: Record<string, unknown>): void {
  noteEntry(state, t)
  const p = (o.payload ?? {}) as Record<string, unknown>
  const sub = p.type as string | undefined

  if (o.type === 'response_item' && (sub === 'function_call' || sub === 'custom_tool_call')) {
    state.pending.set(String(p.call_id), {
      start: t,
      name: String(p.name ?? sub),
      args: String(p.arguments ?? p.input ?? ''),
    })
  } else if (o.type === 'response_item' && (sub === 'function_call_output' || sub === 'custom_tool_call_output')) {
    const call = state.pending.get(String(p.call_id))
    if (!call) return
    state.pending.delete(String(p.call_id))
    const output = JSON.stringify(p.output ?? '').slice(0, 4000)
    state.intervals.push(...classifyCodexCall(call.start, t, call.name, call.args, output))
    const codes = [...output.matchAll(EXIT_RE)].map(m => m[1]!).filter(c => c !== '0')
    if (codes.length > 0) {
      state.marks.push({
        at: t,
        kind: 'tool-failed',
        name: call.name,
        detail: `exit ${codes.slice(0, 3).join('/')} · ${snip(call.args)}`,
      })
    }
  } else if (o.type === 'event_msg') {
    if (sub === 'user_message') state.humans.push(t)
    else if (sub === 'task_complete') state.ends.push(t)
    else if (sub === 'context_compacted') {
      state.intervals.push({ start: t, end: t + 2, kind: 'compact', name: 'compaction', detail: '' })
    } else if (sub === 'sub_agent_activity' && p.kind === 'interrupted') {
      state.marks.push({
        at: t,
        kind: 'subagent-interrupted',
        name: 'sub-agent',
        detail: snip(String(p.agent_path ?? '')),
      })
    }
  }
}

/**
 * Whole-file convenience read. The live path in index.ts feeds lines
 * incrementally instead; this exists for tests and one-off scripts.
 */
export function readCodexTranscript(path: string, now = Date.now() / 1000): ParseResult {
  const state = newReaderState()
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try { o = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const t = secOf(o.timestamp)
    if (t === null || !plausibleTime(t, now)) continue
    feedCodexEntry(state, t, o)
  }
  return finishState(state, now)
}

export interface RolloutCandidate { startedSec: number; path: string }

/**
 * How far a rollout's own start may sit from the session's creation and still
 * be believed to belong to it. Beyond this, "nearest" is just the least-wrong
 * stranger — two sessions in one working directory otherwise resolve to the
 * same rollout and the second card shows the first session's time usage.
 */
export const ROLLOUT_MATCH_TOLERANCE_SEC = 900

/**
 * Choose the rollout whose own start is nearest the Tinstar session's creation.
 *
 * Newest-mtime is wrong, and wrong in a way that looks right: a session that
 * spawns sub-agents fills its own working directory with their rollouts, and
 * one of those is usually the most recently written file. Discovery flipped to
 * a sub-agent's log mid-spike because of exactly this (R19).
 *
 * Returns null rather than a distant stranger, so the panel shows an honest
 * "no transcript" instead of another session's history.
 */
export function pickCodexRollout(createdSec: number, candidates: RolloutCandidate[]): string | null {
  if (candidates.length === 0) return null
  const best = candidates.reduce((b, c) =>
    Math.abs(c.startedSec - createdSec) < Math.abs(b.startedSec - createdSec) ? c : b)
  return Math.abs(best.startedSec - createdSec) <= ROLLOUT_MATCH_TOLERANCE_SEC ? best.path : null
}

/** Scan the Codex sessions tree for rollouts whose session_meta cwd matches. */
export function findCodexCandidates(root: string, cwd: string): RolloutCandidate[] {
  const out: RolloutCandidate[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || !existsSync(dir)) return
    let names: string[]
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      const p = join(dir, name)
      let st: ReturnType<typeof statSync>
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) { walk(p, depth + 1); continue }
      if (!name.endsWith('.jsonl')) continue
      const meta = readSessionMeta(p)
      if (meta && meta.cwd === cwd) out.push({ startedSec: meta.startedSec, path: p })
    }
  }
  walk(root, 0)
  return out
}

/**
 * Read just the first line, which carries session_meta. It can exceed 15KB
 * because it holds the whole system prompt, so this reads a bounded prefix
 * rather than the file.
 */
function readSessionMeta(path: string): { cwd: string; startedSec: number } | null {
  try {
    const size = statSync(path).size
    const fd = openSync(path, 'r')
    const buf = Buffer.alloc(Math.min(32_768, size))
    const n = readSync(fd, buf, 0, buf.length, 0)
    closeSync(fd)
    const first = buf.toString('utf-8', 0, n).split('\n')[0]
    if (!first) return null
    const o = JSON.parse(first) as Record<string, unknown>
    if (o.type !== 'session_meta') return null
    const p = (o.payload ?? {}) as Record<string, unknown>
    const started = secOf(p.timestamp ?? o.timestamp)
    return { cwd: String(p.cwd ?? ''), startedSec: started ?? statSync(path).mtimeMs / 1000 }
  } catch { return null }
}

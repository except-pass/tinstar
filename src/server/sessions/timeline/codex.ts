import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { classifyCodexCall, closeUnmatched, type PendingCall } from './classify'
import type { Interval, Mark } from './types'

export interface ParseResult {
  intervals: Interval[]
  marks: Mark[]
  turns: [number, number, boolean][]
  t0: number | null
  t1: number | null
}

/**
 * The only trustworthy failure signal. The words "error" and "failed" appear in
 * roughly 1,800 tool outputs in the measured corpus — nearly all of them grep
 * hits and test summaries — so matching on them would bury the real failures
 * rather than surface them (R12).
 */
const EXIT_RE = /Process exited with code (\d+)/g

export const secOf = (iso: unknown): number | null => {
  if (typeof iso !== 'string') return null
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? null : ms / 1000
}

/** Tolerance for clock skew between whoever wrote the transcript and this process. */
const FUTURE_TOLERANCE_SEC = 300

/**
 * Reject a timestamp that cannot belong to this transcript.
 *
 * Only the future is rejected. A single future-dated entry stretches the span to
 * centuries — every real band collapses to a sub-pixel sliver — and the
 * size-keyed cache then serves that poisoned reconstruction until the file next
 * grows. An unusually OLD timestamp is left alone deliberately: there is no
 * honest absolute floor (a resumed or imported transcript can legitimately reach
 * back a long way), and an arbitrary one would silently discard real history.
 */
export function plausibleTime(t: number, now: number): boolean {
  return t <= now + FUTURE_TOLERANCE_SEC
}

const snip = (s: string): string => s.replace(/\s+/g, ' ').slice(0, 110)

interface Entry { t: number; o: Record<string, unknown> }

function readEntries(path: string, now: number): Entry[] {
  const entries: Entry[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try { o = JSON.parse(line) as Record<string, unknown> } catch { continue }
    const t = secOf(o.timestamp)
    if (t === null || !plausibleTime(t, now)) continue
    entries.push({ t, o })
  }
  entries.sort((a, b) => a.t - b.t)
  return entries
}

/** Codex rollout JSONL → intervals, marks and turn boundaries. */
export function readCodexTranscript(path: string, now = Date.now() / 1000): ParseResult {
  const entries = readEntries(path, now)

  const pending = new Map<string, PendingCall>()
  const intervals: Interval[] = []
  const marks: Mark[] = []
  const humans: number[] = []
  const ends: number[] = []

  for (const { t, o } of entries) {
    const p = (o.payload ?? {}) as Record<string, unknown>
    const sub = p.type as string | undefined

    if (o.type === 'response_item' && (sub === 'function_call' || sub === 'custom_tool_call')) {
      pending.set(String(p.call_id), {
        start: t,
        name: String(p.name ?? sub),
        args: String(p.arguments ?? p.input ?? ''),
      })
    } else if (o.type === 'response_item' && (sub === 'function_call_output' || sub === 'custom_tool_call_output')) {
      const call = pending.get(String(p.call_id))
      if (!call) continue
      pending.delete(String(p.call_id))
      const output = JSON.stringify(p.output ?? '').slice(0, 4000)
      intervals.push(...classifyCodexCall(call.start, t, call.name, call.args, output))
      const codes = [...output.matchAll(EXIT_RE)].map(m => m[1]!).filter(c => c !== '0')
      if (codes.length > 0) {
        marks.push({
          at: t,
          kind: 'tool-failed',
          name: call.name,
          detail: `exit ${codes.slice(0, 3).join('/')} · ${snip(call.args)}`,
        })
      }
    } else if (o.type === 'event_msg') {
      if (sub === 'user_message') humans.push(t)
      else if (sub === 'task_complete') ends.push(t)
      else if (sub === 'context_compacted') {
        intervals.push({ start: t, end: t + 2, kind: 'compact', name: 'compaction', detail: '' })
      } else if (sub === 'sub_agent_activity' && p.kind === 'interrupted') {
        marks.push({
          at: t,
          kind: 'subagent-interrupted',
          name: 'sub-agent',
          detail: snip(String(p.agent_path ?? '')),
        })
      }
    }
  }

  const t0 = entries.length > 0 ? entries[0]!.t : null
  const t1 = entries.length > 0 ? entries[entries.length - 1]!.t : null
  intervals.push(...closeUnmatched([...pending.values()], entries.map(e => e.t), now))
  if (t1 !== null) intervals.push(...idleIntervals(humans, ends, t1))
  return { intervals, marks, turns: buildTurns(humans, ends, t1), t0, t1 }
}

/**
 * Idle = the agent finished and nothing happened until the user spoke.
 *
 * Pair each human message with the LAST turn end before it. Pairing with every
 * earlier end manufactures overlapping idle windows — the bug that made one
 * session report 138h of idle across a 96h life.
 */
export function idleIntervals(humans: number[], ends: number[], t1: number): Interval[] {
  const out: Interval[] = []
  const sortedEnds = [...ends].sort((a, b) => a - b)
  let i = 0
  for (const h of [...humans].sort((a, b) => a - b)) {
    let prev: number | null = null
    while (i < sortedEnds.length && sortedEnds[i]! < h) prev = sortedEnds[i++]!
    if (prev !== null && h - prev > 2) {
      out.push({ start: prev, end: h, kind: 'idle', name: 'waiting on you', detail: '' })
    }
  }
  const lastEnd = sortedEnds[sortedEnds.length - 1]
  const lastHuman = humans[humans.length - 1]
  if (lastEnd !== undefined && (lastHuman === undefined || lastEnd > lastHuman) && t1 - lastEnd > 2) {
    out.push({ start: lastEnd, end: t1, kind: 'idle', name: 'waiting on you', detail: '' })
  }
  return out
}

/** A turn runs from a human message to the next turn end, or to now if open. */
export function buildTurns(humans: number[], ends: number[], t1: number | null): [number, number, boolean][] {
  if (t1 === null) return []
  const sortedEnds = [...ends].sort((a, b) => a - b)
  return [...humans].sort((a, b) => a - b).map(h => {
    const e = sortedEnds.find(x => x > h)
    return [h, e ?? t1, e === undefined] as [number, number, boolean]
  })
}

export interface RolloutCandidate { startedSec: number; path: string }

/**
 * Choose the rollout whose own start is nearest the Tinstar session's creation.
 *
 * Newest-mtime is wrong, and wrong in a way that looks right: a session that
 * spawns sub-agents fills its own working directory with their rollouts, and
 * one of those is usually the most recently written file. Discovery flipped to
 * a sub-agent's log mid-spike because of exactly this (R19).
 */
export function pickCodexRollout(createdSec: number, candidates: RolloutCandidate[]): string | null {
  if (candidates.length === 0) return null
  return candidates.reduce((best, c) =>
    Math.abs(c.startedSec - createdSec) < Math.abs(best.startedSec - createdSec) ? c : best).path
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

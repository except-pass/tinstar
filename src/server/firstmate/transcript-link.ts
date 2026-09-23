// M3: link an observed first mate worker to its Claude Code conversation.
//
// The first mate does not pass `--session-id` to claude and records no conversation
// id, so there is no exact link. Path alone is ambiguous too, because treehouse
// reuses worktree slots (several tasks' transcripts share one project directory).
// The rule below narrows it heuristically:
//
//   candidates : top-level `*.jsonl` in the Claude project dir for the worktree
//   accept     : first user/assistant record has `cwd == worktree`,
//                `isSidechain == false`, an interactive `entrypoint` (headless
//                `claude -p` runs report an `sdk-*` entrypoint and are skipped),
//                and a timestamp >= spawn time - SPAWN_SKEW_SEC
//   pick       : the candidate appended to most recently (follows relaunch and /clear)
//
// READ-ONLY and display-only: a wrong link can mislabel one card's light or
// timeline, never trigger an action. Nothing here writes to a transcript.

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getProjectDir } from '../sessions/transcript-parser'

/** `task.dispatched` is written after launch, and clocks skew: accept a first record
 *  this much older than the recorded spawn time. */
export const SPAWN_SKEW_SEC = 120

const HEAD_BYTES = 64 * 1024
const CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,79}$/

export interface LinkedTranscript {
  conversationId: string
  path: string
  mtimeMs: number
  source: 'auto' | 'manual'
}

export interface LinkOpts {
  worktree: string
  /** Unix seconds the worker was (re)spawned: meta `spawn_gen`, else the ledger dispatch ts. */
  spawnSec: number | null
  /** Manual override, e.g. a conversation id the operator pasted onto the card. */
  override?: string | null
  /** Test seam; defaults to the Claude adapter's project dir for the worktree. */
  projectDir?: string
}

interface HeadVerdict {
  ok: boolean
  /** First-record timestamp in unix seconds (when `ok` or merely too old). */
  firstSec: number | null
}

/** A transcript's first record never changes, so the verdict is cached per path. */
const headCache = new Map<string, { worktree: string; verdict: HeadVerdict }>()
const HEAD_CACHE_MAX = 1000

export function isValidConversationId(id: unknown): id is string {
  return typeof id === 'string' && CONVERSATION_ID_RE.test(id)
}

function readHead(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.toString('utf8', 0, n)
  } finally {
    closeSync(fd)
  }
}

function judgeHead(path: string, worktree: string): HeadVerdict {
  const cached = headCache.get(path)
  if (cached && cached.worktree === worktree) return cached.verdict
  let verdict: HeadVerdict = { ok: false, firstSec: null }
  let complete = false
  try {
    const lines = readHead(path).split('\n')
    lines.pop() // trailing partial line (or empty string after the final newline)
    for (const line of lines) {
      if (!line.trim()) continue
      let o: Record<string, unknown>
      try { o = JSON.parse(line) as Record<string, unknown> } catch { continue }
      if (o.type !== 'user' && o.type !== 'assistant') continue
      const ms = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
      const entry = typeof o.entrypoint === 'string' ? o.entrypoint : ''
      verdict = {
        ok: o.cwd === worktree && o.isSidechain === false && !entry.startsWith('sdk'),
        firstSec: Number.isFinite(ms) ? ms / 1000 : null,
      }
      complete = true
      break
    }
  } catch {
    return verdict // unreadable right now: do not cache
  }
  if (complete) {
    if (headCache.size >= HEAD_CACHE_MAX) headCache.clear()
    headCache.set(path, { worktree, verdict })
  }
  return verdict
}

/** Resolve the worker's conversation, or null when nothing plausible exists yet. */
export function findLinkedTranscript(opts: LinkOpts): LinkedTranscript | null {
  const dir = opts.projectDir ?? getProjectDir(opts.worktree)

  if (opts.override) {
    if (!isValidConversationId(opts.override)) return null
    const path = join(dir, `${opts.override}.jsonl`)
    try {
      return { conversationId: opts.override, path, mtimeMs: statSync(path).mtimeMs, source: 'manual' }
    } catch {
      return null
    }
  }

  let names: string[]
  try { names = readdirSync(dir) } catch { return null }
  const earliest = opts.spawnSec === null ? null : opts.spawnSec - SPAWN_SKEW_SEC

  let best: LinkedTranscript | null = null
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const conversationId = name.slice(0, -'.jsonl'.length)
    if (!isValidConversationId(conversationId)) continue
    const path = join(dir, name)
    let mtimeMs: number
    try {
      const st = statSync(path)
      if (!st.isFile()) continue
      mtimeMs = st.mtimeMs
    } catch { continue }
    if (best && mtimeMs <= best.mtimeMs) continue // cheap: skip the head read for losers
    const verdict = judgeHead(path, opts.worktree)
    if (!verdict.ok) continue
    if (earliest !== null && (verdict.firstSec === null || verdict.firstSec < earliest)) continue
    best = { conversationId, path, mtimeMs, source: 'auto' }
  }
  return best
}

// Interim task → endpoint join: read `<home>/state/<task>.meta`.
//
// The meta file is the first mate's INTERNAL, UNDOCUMENTED format (the documented
// contract is the ledger). It is used only for `worktree=` (and `window=`, kept for
// the M2 terminal view) and is treated as best-effort: absent file, unreadable
// file, missing keys, unknown keys, and a missing `backend=` line (= tmux) are all
// normal and never throw. Read-only — Tinstar never writes to a first mate home.

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { isSafeTaskId } from './reducer'

export interface TaskMeta {
  /** tmux target the worker's window lives at, e.g. `firstmate:fm-fix-login`. */
  window: string | null
  worktree: string | null
  /** Project directory name derived from the meta's `project=` path. */
  project: string | null
  /** `backend=` value; null (absent) means tmux. */
  backend: string | null
}

const MAX_META_BYTES = 64 * 1024

export function parseMeta(text: string): TaskMeta {
  const kv = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const eq = raw.indexOf('=')
    if (eq <= 0) continue
    const key = raw.slice(0, eq).trim()
    if (!/^[a-z_]+$/.test(key) || kv.has(key)) continue
    kv.set(key, raw.slice(eq + 1).trim())
  }
  const get = (k: string) => kv.get(k) || null
  const project = get('project')
  return {
    window: get('window'),
    worktree: get('worktree'),
    project: project ? basename(project) || null : null,
    backend: get('backend'),
  }
}

/** Read a task's meta. Returns null when it is absent, oversized, or unreadable. */
export async function readTaskMeta(home: string, task: string): Promise<TaskMeta | null> {
  if (!isSafeTaskId(task)) return null
  try {
    const text = await readFile(join(home, 'state', `${task}.meta`), 'utf8')
    if (text.length > MAX_META_BYTES) return null
    return parseMeta(text)
  } catch {
    return null
  }
}

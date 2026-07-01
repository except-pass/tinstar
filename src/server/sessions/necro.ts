// Necro — revive a retired (tombstoned) session so it can be asked questions.
//
// Because delete removes the per-session dir and worktree, reviving a deleted
// session means re-materializing a fresh session record bound to the tombstone's
// stored convId, then resuming it (`claude --resume <convId>`). Revive is
// best-effort: it depends on Claude Code's retained transcript, which Tinstar
// does not own. When that transcript is gone, we report not-revivable and the
// caller falls back to the stored covers-summary.
//
// Ground-truth handle is the tombstone's stored convId — resolve the transcript
// by that id, NEVER by a newest-mtime scan (that misattributes transcripts in a
// shared worktree).

import type { Tombstone } from '../../domain/types'

export interface NecroResult {
  revivable: boolean
  /** Name of the revived (re-materialized) session, when revivable. */
  sessionName?: string
  /** Why revive was refused, when not revivable. */
  reason?: 'transcript-unavailable'
  /** True when the original worktree was gone and revive fell back to a
   *  substitute cwd — the agent remembers the conversation but its code context
   *  is absent (AE1). */
  workspaceMissing?: boolean
}

export interface NecroDeps {
  /** Resolve the Claude Code transcript path for a convId, or null if gone.
   *  Back this with findTranscriptByConvId — never a newest-mtime walk. */
  findTranscript: (convId: string) => string | null
  /** Whether a session dir with this name currently exists (live or stopped). */
  sessionExists: (name: string) => boolean
  /** Whether a filesystem path still exists (used to test the worktree). */
  pathExists: (path: string) => boolean
  /** Create a fresh session bound to `convId`, rooted at `workspacePath`
   *  (null ⇒ caller picks a fallback cwd). */
  materialize: (opts: { name: string; convId: string; workspacePath: string | null }) => void | Promise<void>
  /** Start the materialized session in resume mode against its convId. */
  resume: (name: string) => void | Promise<void>
}

/** Pick a session name for the revived agent that doesn't collide with a live one. */
export function reviveName(base: string, exists: (name: string) => boolean): string {
  const first = `${base}-necro`
  if (!exists(first)) return first
  for (let i = 2; i < 100; i++) {
    const candidate = `${first}-${i}`
    if (!exists(candidate)) return candidate
  }
  return `${first}-${Date.now()}`
}

export async function reviveFromTombstone(tombstone: Tombstone, deps: NecroDeps): Promise<NecroResult> {
  // AE2: transcript gone → not revivable; caller surfaces the covers-summary.
  if (!deps.findTranscript(tombstone.convId)) {
    return { revivable: false, reason: 'transcript-unavailable' }
  }

  const name = reviveName(tombstone.sessionName, deps.sessionExists)

  // AE1: original worktree may be gone — fall back to no cwd (caller resolves one).
  const hasWorkspace = !!tombstone.workspacePath && deps.pathExists(tombstone.workspacePath)
  const workspacePath = hasWorkspace ? tombstone.workspacePath! : null

  // Bind the stored convId (fidelity) — resume against exactly this conversation.
  await deps.materialize({ name, convId: tombstone.convId, workspacePath })
  await deps.resume(name)

  return {
    revivable: true,
    sessionName: name,
    workspaceMissing: !!tombstone.workspacePath && !hasWorkspace,
  }
}

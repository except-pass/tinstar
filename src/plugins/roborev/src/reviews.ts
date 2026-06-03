/** Row shape the accessory renders (mirrors the server `RoborevReview` subset). */
export interface Review {
  id: number
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped'
  verdict: string | null
  closed: boolean
  commit_subject: string
  branch: string
  repo_path: string
  finished_at: string | null
}

export type ReviewAction = 'close' | 'reopen' | 'comment'

/** Open reviews first, then by id descending (newest first within a group). */
export function sortReviews(reviews: Review[]): Review[] {
  return [...reviews].sort((a, b) => {
    if (a.closed !== b.closed) return a.closed ? 1 : -1
    return b.id - a.id
  })
}

/** Slices of /api/state this module reads (real shapes, arrays). */
interface SessionSlice { name: string; project?: string; cliTemplate?: string; lastActive?: string; workspace?: { path?: string } }
interface WorktreeSlice { id: string; worktreePath?: string }
interface RunSlice { id: string; sessionId?: string; worktreeId?: string }
interface StateSlice { sessions?: SessionSlice[]; worktrees?: WorktreeSlice[]; runs?: RunSlice[] }

/** Absolute repo dir the cockpit filters/acts on. Prefer the cockpit session's
 *  own workspace cwd (the exact dir its `roborev tui` runs in, guaranteeing the
 *  pane and the TUI agree); fall back to its run→worktree path; then the
 *  persisted explicit hint; else null. */
export function resolveRepoPath(state: StateSlice, sessionId: string, explicit?: string): string | null {
  const sess = state.sessions?.find((s) => s.name === sessionId)
  if (sess?.workspace?.path) return sess.workspace.path
  const run = state.runs?.find((r) => r.id === sessionId || r.sessionId === sessionId)
  const wt = run?.worktreeId ? state.worktrees?.find((w) => w.id === run.worktreeId) : undefined
  if (wt?.worktreePath) return wt.worktreePath
  return explicit ?? null
}

/** Choose which existing session the freshly-dropped cockpit should mirror: the
 *  most-recently-active real session (not another cockpit) that has a concrete
 *  workspace path + project. Returns the {project, worktreePath} to create the
 *  cockpit's own roborev-tui session in, or null if none qualifies. */
export function pickBootstrapSource(state: StateSlice): { project: string; worktreePath: string } | null {
  const candidates = (state.sessions ?? [])
    .filter((s) => s.cliTemplate !== 'roborev-tui' && !!s.workspace?.path && !!s.project)
    .sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? ''))
  const src = candidates[0]
  if (!src?.project || !src.workspace?.path) return null
  return { project: src.project, worktreePath: src.workspace.path }
}

/** Optimistic local update for an action before the server/stream confirms. */
export function applyOptimisticAction(reviews: Review[], jobId: number, action: ReviewAction): Review[] {
  if (action === 'comment') return reviews
  return reviews.map((r) =>
    r.id === jobId ? { ...r, closed: action === 'close' } : r,
  )
}

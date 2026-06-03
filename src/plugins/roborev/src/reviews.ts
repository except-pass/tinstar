/** Row shape the accessory renders (subset of `roborev list --json`). */
export interface Review {
  id: number
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped'
  verdict: string | null
  closed: boolean
  commit_subject: string
  branch: string
}

export type ReviewAction = 'close' | 'reopen' | 'comment'

/** Parse `roborev list --json` stdout into Review rows. Tolerates empty output
 *  and missing optional fields (verdict can be absent). */
export function parseReviewList(stdout: string): Review[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const raw = JSON.parse(trimmed) as Array<Record<string, unknown>>
  return raw.map((j) => ({
    id: Number(j.id),
    status: (j.status as Review['status']) ?? 'done',
    verdict: (j.verdict as string | undefined) ?? null,
    closed: Boolean(j.closed),
    commit_subject: String(j.commit_subject ?? ''),
    branch: String(j.branch ?? ''),
  }))
}

/** Findings text from `roborev show --json` (the `output` field). */
export function parseReviewShow(stdout: string): string {
  const t = stdout.trim()
  if (!t) return ''
  const o = JSON.parse(t) as { output?: string }
  return o.output ?? ''
}

/** Open reviews first, then by id descending. */
export function sortReviews(reviews: Review[]): Review[] {
  return [...reviews].sort((a, b) => (a.closed !== b.closed ? (a.closed ? 1 : -1) : b.id - a.id))
}

/** Optimistic local update before the next poll confirms. */
export function applyOptimisticAction(reviews: Review[], jobId: number, action: ReviewAction): Review[] {
  if (action === 'comment') return reviews
  return reviews.map((r) => (r.id === jobId ? { ...r, closed: action === 'close' } : r))
}

/** Build the argv for a roborev action (run via terminal.exec). */
export function actionArgv(jobId: number, action: ReviewAction, message?: string): string[] {
  switch (action) {
    case 'close': return ['roborev', 'close', String(jobId)]
    case 'reopen': return ['roborev', 'close', String(jobId), '--reopen']
    case 'comment': return ['roborev', 'comment', '--job', String(jobId), '-m', message ?? '']
  }
}

/** Slices of /api/state pickBootstrapSource reads (real shapes — arrays). */
interface SessionSlice { name: string; project?: string; cliTemplate?: string; lastActive?: string; workspace?: { path?: string } }
interface StateSlice { sessions?: SessionSlice[] }

/** Choose which existing session the freshly-dropped cockpit should create its
 *  shell in: the most-recently-active real session (not another cockpit shell)
 *  that has a concrete workspace path + project. Returns {project, worktreePath}
 *  to pass to POST /api/sessions, or null if none qualifies. */
export function pickBootstrapSource(state: StateSlice): { project: string; worktreePath: string } | null {
  const candidates = (state.sessions ?? [])
    .filter((s) => s.cliTemplate !== 'shell' && s.cliTemplate !== 'roborev-tui' && !!s.workspace?.path && !!s.project)
    .sort((a, b) => (b.lastActive ?? '').localeCompare(a.lastActive ?? ''))
  const src = candidates[0]
  if (!src?.project || !src.workspace?.path) return null
  return { project: src.project, worktreePath: src.workspace.path }
}

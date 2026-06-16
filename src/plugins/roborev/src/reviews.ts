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
  const raw = JSON.parse(trimmed)
  // `roborev list --json` emits `null` (not `[]`) for a repo with no reviews.
  if (!Array.isArray(raw)) return []
  return (raw as Array<Record<string, unknown>>).map((j) => ({
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

/** What the cockpit accessory should render, resolved from the probe inputs.
 *  Keeps the branchy "why is this pane empty?" logic pure and testable so the
 *  accessory never falls back to a blank/ambiguous state. `installed` is the
 *  result of a `which roborev` probe (null until it resolves). */
export type CockpitView =
  | { kind: 'no-session' }
  | { kind: 'probing' }
  | { kind: 'not-installed' }
  | { kind: 'error'; message: string }
  | { kind: 'empty' }
  | { kind: 'list'; reviews: Review[]; open: number }

export function cockpitState(input: {
  sessionId: string
  installed: boolean | null
  error: string | null
  reviews: Review[]
}): CockpitView {
  if (!input.sessionId) return { kind: 'no-session' }
  if (input.installed === false) return { kind: 'not-installed' }
  if (input.reviews.length > 0) {
    return { kind: 'list', reviews: input.reviews, open: input.reviews.filter((r) => !r.closed).length }
  }
  if (input.error) return { kind: 'error', message: input.error }
  if (input.installed === null) return { kind: 'probing' }
  return { kind: 'empty' }
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

/** Extract the created session's identifier from a POST /api/sessions response.
 *  A tinstar Session is keyed by `name` (there is no `id` field); we tolerate a
 *  legacy `id` just in case. Returns null on a failed/!ok response. */
export function sessionIdFromCreate(body: unknown): string | null {
  const b = body as { ok?: boolean; data?: { name?: string; id?: string } }
  if (!b?.ok) return null
  return b.data?.name ?? b.data?.id ?? null
}

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

// ── Fleet overview (standalone roborev-fleet widget) ───────────────────────────

export interface FleetSession { sessionId: string; project: string; worktree: string }

/** Real agent sessions with a worktree we can run `roborev list` in. Excludes the
 *  shell/cockpit helper sessions, mirroring pickBootstrapSource's filter. */
export function pickFleetSessions(state: StateSlice): FleetSession[] {
  return (state.sessions ?? [])
    .filter((s) => s.cliTemplate !== 'shell' && s.cliTemplate !== 'roborev-tui' && !!s.workspace?.path)
    .map((s) => ({ sessionId: s.name, project: s.project ?? '', worktree: s.workspace!.path! }))
}

export interface FleetRow extends FleetSession {
  /** null = the per-session probe failed (roborev missing / exec error). */
  open: number | null
  failed: number
}

/** One fleet row: open-finding counts for a session, from its `roborev list
 *  --open --json` output. `open: null` signals the probe failed for that session. */
export function fleetRow(session: FleetSession, openReviews: Review[] | null): FleetRow {
  if (openReviews === null) return { ...session, open: null, failed: 0 }
  return {
    ...session,
    open: openReviews.length,
    failed: openReviews.filter((r) => r.status === 'failed').length,
  }
}

/** Total open findings across the fleet (probe failures count as 0). */
export function fleetOpenTotal(rows: FleetRow[]): number {
  return rows.reduce((n, r) => n + (r.open ?? 0), 0)
}

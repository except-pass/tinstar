/** Snapshot fields the cockpit already reads. No separate pane or busy-file probe. */
export interface MateSnapshot {
  kind?: unknown
  current_state?: { state?: unknown; source?: unknown; detail?: unknown }
  endpoint?: { exists?: unknown; agent_alive?: unknown; status?: unknown }
  hints?: { last_event_text?: unknown }
}

/** Live second-mate summary from the same fleet snapshot (`secondmate_current`). */
export interface MateHomeActivity {
  state: string
  activeChildren: number
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

// Publisher shapes, done or failed: `<state> [key=child-outcome-<id>-<state>-<fp8>]: child <id> <state>: <note>`
// and the fallback `<state> [key=inactive-outcome-<mate>-<id>-<state>]: inactive terminal child=<id> fingerprint=<fp>`.
const CHILD_OUTCOME = /^(done|failed) \[key=(?:child-outcome-[^\]]+\](?: \[[^\]]*\])*: child \S+ \1:|inactive-outcome-[^\]]+\](?: \[[^\]]*\])*: inactive terminal child=\S+)/
const WAITING = new Set(['no_active_work', 'externally_held', 'captain_decision'])

/** A child-outcome line is another task finishing or failing, not the mate's own outcome. */
function isChildOutcome(task: MateSnapshot): boolean {
  if (text(task.kind) !== 'secondmate') return false
  const source = text(task.current_state?.source)
  if (source && source !== 'status-log') return false
  const match = CHILD_OUTCOME.exec(text(task.hints?.last_event_text))
  return !!match && match[1] === text(task.current_state?.state)
}

function presence(task: MateSnapshot, home: MateHomeActivity | null): 'working' | 'idle' | 'unknown' {
  if (home && home.activeChildren > 0) return 'working'
  if (home && WAITING.has(home.state)) return 'idle'
  const alive = text(task.endpoint?.agent_alive)
  const status = text(task.endpoint?.status)
  if (alive === 'alive' || status === 'alive') return 'idle'
  return 'unknown'
}

/**
 * Displayed worker state for the overview, detail, and grouping.
 * Ship and scout workers keep `current_state`. A persistent second mate whose
 * latest status line is a child `done` or `failed` shows working while child work
 * is active and idle while it is waiting; that child outcome stays in the detail.
 */
export function displayedWorkerState(task: MateSnapshot, home: MateHomeActivity | null = null): { state: string; detail: string } {
  const state = text(task.current_state?.state) || 'unknown'
  const detail = text(task.current_state?.detail) || 'unknown'
  if (!isChildOutcome(task)) return { state, detail }
  return { state: presence(task, home), detail }
}

export function secondmateActivityById(snapshot: { secondmate_current?: { records?: unknown } | null }): Map<string, MateHomeActivity> {
  const records = snapshot.secondmate_current?.records
  const mates = new Map<string, MateHomeActivity>()
  if (!Array.isArray(records)) return mates
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const row = record as { id?: unknown; current?: { state?: unknown }; counts?: { active_children?: unknown } }
    const id = text(row.id)
    if (!id) continue
    const counted = row.counts?.active_children
    mates.set(id, { state: text(row.current?.state), activeChildren: typeof counted === 'number' && Number.isFinite(counted) ? counted : 0 })
  }
  return mates
}

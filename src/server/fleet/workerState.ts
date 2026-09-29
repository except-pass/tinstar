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
const REPORT_VERB = /^(working|paused|blocked|needs-decision|done|failed)(?![A-Za-z0-9-])/
const REPORT_STAMP = /\[at=(\d+)\]/

function endpointDead(task: MateSnapshot): boolean {
  return task.endpoint?.exists === false || text(task.endpoint?.agent_alive) === 'dead'
}

function reportAge(unixSeconds: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - unixSeconds * 1000) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** Latest status verb when the snapshot could not read a live state. The verb stays the state word; the detail carries the report age. */
function lastReport(task: MateSnapshot, now: number): { state: string; detail: string } | null {
  const line = text(task.hints?.last_event_text)
  const verb = REPORT_VERB.exec(line)
  if (!verb) return null
  const state = verb[1] ?? 'unknown'
  const stamp = REPORT_STAMP.exec(line)
  const marker = stamp ? `last report ${reportAge(Number(stamp[1]), now)}` : 'last report'
  return { state, detail: `${state} · ${marker}` }
}

/** A child-outcome line is another task finishing or failing, not the mate's own outcome. */
function isChildOutcome(task: MateSnapshot): boolean {
  if (text(task.kind) !== 'secondmate') return false
  const source = text(task.current_state?.source)
  if (source && source !== 'status-log') return false
  const match = CHILD_OUTCOME.exec(text(task.hints?.last_event_text))
  return !!match && match[1] === text(task.current_state?.state)
}

function presence(task: MateSnapshot, home: MateHomeActivity | null): 'working' | 'idle' | 'unknown' {
  if (endpointDead(task)) return 'unknown'
  if (home && home.activeChildren > 0) return 'working'
  if (home && WAITING.has(home.state)) return 'idle'
  if (text(task.endpoint?.agent_alive) === 'alive' || text(task.endpoint?.status) === 'alive') return 'idle'
  return 'unknown'
}

/**
 * Displayed worker state for the overview, detail, grouping, and attention cards.
 * A live snapshot state is kept as read. An unknown state is taken from the latest
 * status line when that line starts with working, paused, blocked, needs-decision,
 * done, or failed, and the detail marks that report's age. A dead endpoint stays
 * unknown. A persistent second mate whose latest status line is a child `done` or
 * `failed` shows working while child work is active and idle while it is waiting;
 * that child outcome stays in the detail.
 */
export function displayedWorkerState(task: MateSnapshot, home: MateHomeActivity | null = null, now = Date.now()): { state: string; detail: string } {
  const state = text(task.current_state?.state) || 'unknown'
  const detail = text(task.current_state?.detail) || 'unknown'
  if (isChildOutcome(task)) return { state: presence(task, home), detail }
  if (state !== 'unknown' || endpointDead(task)) return { state, detail }
  return lastReport(task, now) ?? { state, detail }
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

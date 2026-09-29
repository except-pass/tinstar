/** Snapshot fields the cockpit already reads. No separate pane or busy-file probe. */
export interface MateSnapshot {
  kind?: unknown
  current_state?: { state?: unknown; source?: unknown; detail?: unknown }
  endpoint?: { exists?: unknown; agent_alive?: unknown; status?: unknown }
  paths?: { status_log?: { last_event?: { state?: unknown; note?: unknown; raw?: unknown; age_seconds?: unknown } } }
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
const REPORT_VERBS = new Set(['working', 'paused', 'blocked', 'needs-decision', 'done', 'failed'])
const REPORT_NOTE_MAX = 80

function endpointDead(task: MateSnapshot): boolean {
  return task.endpoint?.exists === false || text(task.endpoint?.agent_alive) === 'dead'
}

function reportAge(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

/** First Mate's parse of the latest status line, used when a live pane state could not be read. The detail is the note and the report age. */
function lastReport(task: MateSnapshot): { state: string; detail: string } | null {
  const event = task.paths?.status_log?.last_event
  const verb = text(event?.state)
  if (!REPORT_VERBS.has(verb)) return null
  const age = event?.age_seconds
  const marker = typeof age === 'number' && Number.isFinite(age) && age >= 0 ? `last report ${reportAge(age)}` : 'last report'
  const note = text(event?.note).replace(/\s+/g, ' ')
  const short = note.length > REPORT_NOTE_MAX ? `${note.slice(0, REPORT_NOTE_MAX - 1).trimEnd()}…` : note
  return { state: verb === 'needs-decision' ? 'parked' : verb, detail: short ? `${short} · ${marker}` : marker }
}

/** A child-outcome line is another task finishing or failing, not the mate's own outcome. */
function childOutcomeVerb(task: MateSnapshot): string | null {
  if (text(task.kind) !== 'secondmate') return null
  return CHILD_OUTCOME.exec(text(task.paths?.status_log?.last_event?.raw))?.[1] ?? null
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
 * A live snapshot state is kept as read. An unknown state read from a pane on a live
 * endpoint is taken from First Mate's parse of the latest status line when its verb is
 * working, paused, blocked, needs-decision (shown as parked), done, or failed, and the
 * detail is that report's note and age. Any other unknown stays unknown. A persistent
 * second mate whose latest status line is a child `done` or `failed` shows working while
 * child work is active and idle while it is waiting; that child outcome stays in the detail.
 */
export function displayedWorkerState(task: MateSnapshot, home: MateHomeActivity | null = null): { state: string; detail: string } {
  const state = text(task.current_state?.state) || 'unknown'
  const detail = text(task.current_state?.detail) || 'unknown'
  const source = text(task.current_state?.source)
  const child = childOutcomeVerb(task)
  if (state === 'unknown') {
    const report = source === 'pane' && !endpointDead(task) ? lastReport(task) : null
    if (!report) return { state, detail }
    return child ? { state: presence(task, home), detail: report.detail } : report
  }
  if (child === state && (!source || source === 'status-log')) return { state: presence(task, home), detail }
  return { state, detail }
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

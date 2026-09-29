/** Snapshot fields the cockpit already reads. No separate pane or busy-file probe. */
export interface MateSnapshot {
  kind?: unknown
  current_state?: { state?: unknown; source?: unknown; detail?: unknown; raw?: unknown }
  endpoint?: { exists?: unknown; agent_alive?: unknown; status?: unknown }
  hints?: { last_event_text?: unknown }
  paths?: { status_log?: { last_event?: { raw?: unknown; note?: unknown } } }
}

/** Live second-mate summary from the same fleet snapshot (`secondmate_current`). */
export interface MateHomeActivity {
  state: string
  activeChildren: number
}

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : ''

// Publisher shape: `done [key=child-outcome-<id>-done-<fp8>]: child <id> done: <note>`
// Crew-state keeps the note as detail and the whole read as `state: done · source: status-log · <note>`.
const CHILD_OUTCOME_KEY = /\[key=child-outcome-[A-Za-z0-9._-]+\]/
const CHILD_OUTCOME_NOTE = /(?:^| · )child \S+ done:/
const WAITING = new Set(['no_active_work', 'externally_held', 'captain_decision'])

function lines(task: MateSnapshot): string[] {
  return [
    text(task.hints?.last_event_text),
    text(task.paths?.status_log?.last_event?.raw),
    text(task.paths?.status_log?.last_event?.note),
    text(task.current_state?.raw),
    text(task.current_state?.detail),
  ].filter(line => line.length > 0)
}

/** A child-outcome `done` line is another task finishing, not the mate's own completion. */
function isChildOutcomeDone(task: MateSnapshot): boolean {
  if (text(task.kind) !== 'secondmate') return false
  if (text(task.current_state?.state) !== 'done') return false
  const source = text(task.current_state?.source)
  if (source && source !== 'status-log') return false
  return lines(task).some(line => CHILD_OUTCOME_NOTE.test(line) || (/^\s*done\b/.test(line) && CHILD_OUTCOME_KEY.test(line)))
}

function presence(task: MateSnapshot, home: MateHomeActivity | null): 'working' | 'idle' | 'unknown' {
  if (home && (home.activeChildren > 0 || home.state === 'active_child_work')) return 'working'
  if (home && WAITING.has(home.state)) return 'idle'
  const alive = text(task.endpoint?.agent_alive)
  const status = text(task.endpoint?.status)
  if (alive === 'alive' || status === 'alive') return 'idle'
  return 'unknown'
}

/**
 * Displayed worker state for the overview, detail, and grouping.
 * Ship and scout workers keep `current_state`. A persistent second mate whose
 * latest status line is a child `done` shows working while child work is active
 * and idle while it is waiting; that child outcome stays in the detail.
 */
export function displayedWorkerState(task: MateSnapshot, home: MateHomeActivity | null = null): { state: string; detail: string } {
  const state = text(task.current_state?.state) || 'unknown'
  const detail = text(task.current_state?.detail) || 'unknown'
  if (!isChildOutcomeDone(task)) return { state, detail }
  return { state: presence(task, home), detail }
}

export function secondmateActivityById(snapshot: { secondmate_current?: { records?: unknown } | null }): Map<string, MateHomeActivity> {
  const records = snapshot.secondmate_current?.records
  const mates = new Map<string, MateHomeActivity>()
  if (!Array.isArray(records)) return mates
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const row = record as { id?: unknown; current?: { state?: unknown }; active_children?: unknown; counts?: { active_children?: unknown } }
    const id = text(row.id)
    if (!id) continue
    const listed = Array.isArray(row.active_children) ? row.active_children.length : 0
    const counted = typeof row.counts?.active_children === 'number' && Number.isFinite(row.counts.active_children) ? row.counts.active_children : 0
    mates.set(id, { state: text(row.current?.state), activeChildren: Math.max(listed, counted) })
  }
  return mates
}

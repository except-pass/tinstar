// Pure reducer for the first mate fleet ledger (contract: the first mate's
// docs/fleet-ledger.md). One WorkerState per task id, folded record by record.
//
// Reader obligations from the contract, all handled here:
//   - ignore unknown members and unknown events (a record we cannot place is a no-op);
//   - tolerate duplicates (every branch is idempotent for a repeated record);
//   - a status record may arrive BEFORE its dispatched record, and tasks
//     dispatched while the ledger flag was off never get one at all — so a worker
//     is created by whichever record mentions it first;
//   - status text is verbatim and untrusted: it is only ever carried as a plain
//     string (capped) and must be rendered as text.
//
// The open-decision fold is DISPLAY-ONLY. The first mate has its own authoritative
// fold (reserved key namespaces, terminal lines superseding older decisions); this
// one only mirrors "needs-decision / blocked opens a key, resolved / captain-held
// closes it", so the card labels it "as reported by the ledger".

export const MAX_STATUS_TEXT = 2000
const DEFAULT_DECISION_KEY = 'default'

/** Task ids become run ids and file names (`<home>/state/<task>.meta`), so anything
 *  that is not a plain slug is refused rather than sanitized. */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
export function isSafeTaskId(task: unknown): task is string {
  return typeof task === 'string' && TASK_ID_RE.test(task) && !task.includes('..')
}

export interface StatusLine {
  /** The status line's leading word (`working`, `needs-decision`, …) or null. */
  state: string | null
  key: string | null
  text: string
  ts: number
}

export interface OpenDecision {
  key: string
  state: string
  text: string
  ts: number
}

export interface WorkerState {
  task: string
  kind: string | null
  project: string | null
  harness: string | null
  model: string | null
  /** `ts` of the `task.dispatched` record; null when it never arrived. */
  dispatchedAt: number | null
  lastStatus: StatusLine | null
  openDecisions: Record<string, OpenDecision>
  pr: string | null
  merged: { via: string; pr: string | null; ts: number } | null
  /** `ts` of `task.cleaned_up`; null while the worker is live. */
  cleanedUpAt: number | null
  /** `ts` of the newest record folded into this worker. */
  updatedAt: number
}

export type FleetState = Map<string, WorkerState>

function freshWorker(task: string, ts: number): WorkerState {
  return {
    task,
    kind: null,
    project: null,
    harness: null,
    model: null,
    dispatchedAt: null,
    lastStatus: null,
    openDecisions: {},
    pr: null,
    merged: null,
    cleanedUpAt: null,
    updatedAt: ts,
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** Parse one ledger line. Returns null for anything that is not a usable record. */
export function parseLedgerLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let value: unknown
  try { value = JSON.parse(trimmed) } catch { return null }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Fold one record into `state`. Returns the task id it changed, or null. */
export function reduceRecord(state: FleetState, record: Record<string, unknown>): string | null {
  const event = record.event
  const task = record.task
  const ts = record.ts
  if (typeof event !== 'string' || !isSafeTaskId(task)) return null
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null

  let w = state.get(task)

  if (event === 'task.dispatched') {
    // A dispatch that is newer than the one on record (or follows a cleanup) is a
    // NEW worker reusing the task id: start over rather than inherit a dead one's
    // decisions and PR. A replayed duplicate has an equal ts and just re-applies.
    if (w && (w.cleanedUpAt !== null || (w.dispatchedAt !== null && ts > w.dispatchedAt))) w = undefined
    if (!w) { w = freshWorker(task, ts); state.set(task, w) }
    w.dispatchedAt = ts
    w.kind = str(record.kind) ?? w.kind
    w.project = str(record.project) ?? w.project
    w.harness = str(record.harness) ?? w.harness
    w.model = str(record.model) ?? w.model
    w.updatedAt = Math.max(w.updatedAt, ts)
    return task
  }

  if (event !== 'task.status' && event !== 'task.pr_ready' && event !== 'task.merged' && event !== 'task.cleaned_up') {
    return null // unknown event: ignore (forward compatibility)
  }

  if (!w) { w = freshWorker(task, ts); state.set(task, w) }
  w.updatedAt = Math.max(w.updatedAt, ts)

  switch (event) {
    case 'task.status': {
      const line: StatusLine = {
        state: str(record.state),
        key: str(record.key),
        text: typeof record.text === 'string' ? record.text.trim().slice(0, MAX_STATUS_TEXT) : '',
        ts,
      }
      if (w.lastStatus && ts < w.lastStatus.ts) return task // stale replay: keep the newer line
      w.lastStatus = line
      const key = line.key ?? DEFAULT_DECISION_KEY
      if (line.state === 'needs-decision' || line.state === 'blocked') {
        w.openDecisions[key] = { key, state: line.state, text: line.text, ts }
      } else if (line.state === 'resolved' || line.state === 'captain-held') {
        delete w.openDecisions[key]
      }
      return task
    }
    case 'task.pr_ready':
      w.pr = str(record.pr) ?? w.pr
      return task
    case 'task.merged': {
      const via = record.via === 'local' ? 'local' : 'pr'
      const pr = str(record.pr)
      w.merged = { via, pr, ts }
      if (pr) w.pr = pr
      return task
    }
    case 'task.cleaned_up':
      w.cleanedUpAt = ts
      return task
  }
  return null
}

export function reduceLines(state: FleetState, lines: Iterable<string>): Set<string> {
  const changed = new Set<string>()
  for (const line of lines) {
    const record = parseLedgerLine(line)
    if (!record) continue
    const task = reduceRecord(state, record)
    if (task) changed.add(task)
  }
  return changed
}

export type ObservedRunStatus = 'running' | 'idle' | 'needs_attention'

/** Ledger status → Tinstar run status (the report's mapping table). */
export function runStatusFor(w: WorkerState): ObservedRunStatus {
  if (w.merged) return 'idle'
  switch (w.lastStatus?.state) {
    case 'needs-decision':
    case 'blocked':
    case 'failed':
      return 'needs_attention'
    case 'paused':
    case 'done':
      return 'idle'
    default:
      return 'running' // working, resolved, unknown, or dispatched with no status yet
  }
}

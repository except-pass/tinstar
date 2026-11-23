import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { retainedExecutionLiveness } from '../shared/executionLiveness'
import { parsePullUrl } from '../server/fleet/attention'
import type { SourceSnapshot } from '../server/reconciliation'
import { dispatchForTask } from '../server/reconciliation/dispatchProvenance'
import type { JiraExternalBlocker } from '../server/reconciliation/jiraWorkRules'
import { ageObservation } from '../server/reconciliation/observation'
import { tswEvidence } from '../server/reconciliation/tswSnapshot'

type Home = SourceSnapshot['fleet'][number]
type Fleet = NonNullable<Home['observation']['data']>
type Task = Fleet['tasks'][number]
type Backlog = NonNullable<Fleet['backlog']>[number]
type EventDetails =
  | { target: 'In Progress' }
  | { target: 'Ready for Review'; pull: string }
  | { target: 'Done' }
  | { target: 'Decision'; questions: string[] }
  | { target: 'Waiting For'; blocker: JiraExternalBlocker }

export type StatusEvent = EventDetails & {
  key: string
  home: string
  task: string
  actor: string
  owner: string
  expiresAt: string | null
  id: string
  evidence: string
}
export type StatusSourceFinding = { home: string; key?: string; task?: string; reason: string }

const eventId = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const pullUrl = (value: unknown) => typeof value === 'string' && parsePullUrl(value) ? value : null
const eventVerb = (value: string | null) => value?.trim().match(/^([a-z-]+)(?=\s|:|$)/i)?.[1]?.toLowerCase()

function authority(home: string) {
  const mate = basename(home).replace(/^fm-/, '')
  if (mate === 'firstmate' || mate === 'main') return { actor: 'Firstmate', owner: 'Firstmate' }
  if (mate === 'home' || mate === 'hulk') return { actor: 'Firstmate hulk', owner: 'Hulk' }
  return { actor: `Firstmate ${mate}`, owner: `Firstmate ${mate}` }
}

function classify(home: string, id: string, task: Task | undefined, row: Backlog | undefined, now: number) {
  function event(details: EventDetails, witness: unknown, evidence: string) {
    return { details, witness, evidence }
  }
  const state = task?.current_state.freshness === 'fresh' ? task.current_state : null
  const detail = typeof state?.detail === 'string' ? state.detail : ''
  const last = task?.lastEventText ?? (typeof task?.last_event.raw === 'string' ? task.last_event.raw : null)
  const verb = eventVerb(last)
  const summary = last?.replace(/^[^:]*:\s*/, '').trim()
  const source = row?.[tswEvidence]
  const attempt = task?.[tswEvidence]
  const terminal = [source, attempt].find(s => s?.merged || s?.completion === 'merged' || s?.completion === 'done')
  const pull = pullUrl(terminal?.pull) ?? pullUrl(task?.pr.url) ?? pullUrl(source?.pull) ?? pullUrl(attempt?.pull)
  const mergedState = /^(?:run passed: PR merged|PR merged)(?:\b|:)/i.test(detail)
  const mergedEvent = verb === 'merged' || verb === 'landed' || verb === 'done' &&
    /^(?:merged\b|landed\b|PR https:\/\/github\.com\/\S+\/pull\/\d+ merged\b)/i.test(summary ?? '')
  if (terminal || mergedState || mergedEvent) {
    if (!pull) return 'completion-without-pull-evidence'
    return event({ target: 'Done' }, [pull, terminal?.completedOn ?? null], `First Mate reported delivery for ${id}. ${pull}`)
  }

  const decisions = (task?.queue?.decisions ?? []).filter(item => item.verb === 'needs-decision' && item.summary?.trim())
  const questions = [...new Set(decisions.map(item => item.summary!.trim()))].sort()
  if (!questions.length && verb === 'needs-decision' && summary) questions.push(summary)
  if (questions.length) return event({ target: 'Decision', questions },
    [decisions.map(item => item.key).sort(), questions], `First Mate requested a decision for ${id}.`)

  const hold = source?.holdKind === 'external' ? row : attempt?.holdKind === 'external' ? task?.backlog : undefined
  if (hold) {
    const reason = typeof hold.hold_reason === 'string' ? hold.hold_reason.trim() : ''
    const target = hold.blocked_by_ids?.[0] ?? `fm:${home}:${id}`
    if (!reason || !/^\S+$/.test(target)) return 'external-hold-without-blocker-evidence'
    const until = typeof hold.hold_until === 'string' ? hold.hold_until.trim() : ''
    const blocker = { type: 'Event' as const, target, unblocks_when: until ? `${reason}\nHold until ${until}` : reason }
    return event({ target: 'Waiting For', blocker }, blocker, `First Mate declared an external wait for ${id}.`)
  }

  const ready = /^(?:run passed: PR open|checks green: PR (?:held for merge|ready for review))\b/i.test(detail) ||
    (verb === 'done' || verb === 'pr-ready') && (/^PR https:\/\/github\.com\/\S+\/pull\/\d+ checks green\b/i.test(summary ?? '') || verb === 'pr-ready')
  if (ready) {
    if (!pull) return 'review-without-pull-evidence'
    if (attempt?.yolo === 'off') return event({ target: 'Ready for Review', pull }, pull, `First Mate reported checks green. ${pull}`)
    if (attempt?.yolo === 'on') return event({ target: 'In Progress' }, ['mate-merges', pull], `First Mate is responsible for merging ${pull}`)
    return 'merge-authority-unavailable'
  }
  // A completion checkpoint can precede the merge and a paused local pipeline
  // can still own a spawned worker. An absent endpoint alone proves neither.
  if (task?.identity.spawn_gen && (
    retainedExecutionLiveness(task, now) === 'running' ||
    state?.state === 'working' ||
    task.endpoint.exists === true && task.backlog.state === 'in_flight' &&
      !['done', 'failed', 'landed'].includes(verb ?? '') && !['done', 'failed', 'landed'].includes(String(state?.state))
  )) return event({ target: 'In Progress' }, 'spawned', `First Mate worker ${id} is active (attempt ${task.identity.spawn_gen}).`)
  return 'no-actionable-event'
}

export function collectTswEvents(fleet: SourceSnapshot['fleet'], now: number) {
  const findings: StatusSourceFinding[] = []
  const byKey = new Map<string, StatusEvent[]>()
  for (const { source, observation: read } of fleet) {
    const home = source.home
    const observation = ageObservation(read, now)
    if (observation.status !== 'fresh' || observation.coverage !== 'complete' || !observation.data) {
      findings.push({ home, reason: `snapshot-${observation.status}-${observation.coverage}` })
      continue
    }
    const rows = new Map(observation.data.backlog?.map(row => [row.id, row]))
    const joined = new Set<Backlog>()
    const subjects = observation.data.tasks.filter(task => task.kind !== 'secondmate').map(task => {
      const id = task.identity.task_id
      const row = rows.get(task.backlog.id ?? id)
      if (row) joined.add(row)
      return { id, task, row }
    })
    const backlogOnly = [...rows.values()].filter(row => !joined.has(row)).map(row => ({ id: row.id, row, task: undefined }))
    for (const { id, task, row } of [...subjects, ...backlogOnly]) {
      if (typeof id !== 'string' || !id) continue
      const dispatch = dispatchForTask(task?.[tswEvidence] ?? {}, row?.[tswEvidence])
      if (dispatch.status !== 'card') {
        const tagged = [task?.[tswEvidence]?.dispatchProvenance, row?.[tswEvidence]?.dispatchProvenance].find(p => p?.status === 'card')
        if (tagged?.status === 'card') findings.push({ home, key: tagged.cardId, task: id, reason: 'conflicting-card-declarations' })
        continue
      }
      const key = dispatch.cardId
      const signal = classify(home, id, task, row, now)
      if (typeof signal === 'string') {
        findings.push({ home, key, task: id, reason: signal })
        continue
      }
      const events = byKey.get(key) ?? []
      events.push({
        ...signal.details, ...authority(home), key, home, task: id, expiresAt: observation.expiresAt,
        id: eventId([home, id, task?.identity.spawn_gen ?? null, signal.details.target, signal.witness]),
        evidence: signal.evidence,
      })
      byKey.set(key, events)
    }
  }
  const events: StatusEvent[] = []
  for (const [key, candidates] of byKey) {
    if (candidates.length === 1 && !findings.some(finding => finding.key === key && finding.reason === 'conflicting-card-declarations')) {
      events.push(candidates[0]!)
    } else {
      for (const candidate of candidates) findings.push({ key, home: candidate.home, task: candidate.task, reason: 'competing-task-events' })
    }
  }
  return { events: events.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true })), findings }
}

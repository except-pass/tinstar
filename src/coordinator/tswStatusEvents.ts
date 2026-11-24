import { createHash } from 'node:crypto'
import { codexTurn } from '../shared/codexActivity'
import { retainedExecutionLiveness } from '../shared/executionLiveness'
import { releasePull } from '../shared/pullIdentity'
import { parsePullUrl } from '../server/fleet/attention'
import type { SourceSnapshot } from '../server/reconciliation'
import { dispatchForTask } from '../server/reconciliation/dispatchProvenance'
import { readyHeadPublication, requestedHead } from '../server/reconciliation/ownerRequestEvidence'
import { ageObservation } from '../server/reconciliation/observation'
import { tswEvidence } from '../server/reconciliation/tswSnapshot'
import { isPublishedReviewDetail } from '../server/reconciliation/workerLinkReport'

type Home = SourceSnapshot['fleet'][number]
type Fleet = NonNullable<Home['observation']['data']>
type Task = Fleet['tasks'][number]
type Backlog = NonNullable<Fleet['backlog']>[number]
type EventDetails =
  | { target: 'In Progress' }
  | { target: 'Ready for Review'; pull: string; head: string | null }
  | { target: 'Done' }

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

// TSW Owner dropdown values follow the owner/main convention agreed on 2026-11-23.
const mateAuthority = new Map([
  ['main', { actor: 'Firstmate', owner: 'Firstmate' }],
  ['hulk', { actor: 'Firstmate Hulk', owner: 'Hulk' }],
])

function authority(label: string) {
  return mateAuthority.get(label) ?? { actor: `Firstmate ${label}`, owner: `Firstmate ${label}` }
}

function classify(id: string, task: Task | undefined, row: Backlog | undefined, now: number) {
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
  const mergedState = detail === 'PR merged' || detail === 'run passed: PR merged' ||
    detail === 'checks green: PR merged (ci monitor ended)'
  const mergedEvent = verb === 'merged' || verb === 'landed' || verb === 'done' &&
    /^(?:merged\b|landed\b|PR https:\/\/github\.com\/\S+\/pull\/\d+ merged\b)/i.test(summary ?? '')
  if (terminal || mergedState || mergedEvent) {
    if (!pull) return 'completion-without-pull-evidence'
    return event({ target: 'Done' }, [pull, terminal?.completedOn ?? null], `First Mate reported delivery for ${id}. ${pull}`)
  }

  if (isPublishedReviewDetail(detail) && attempt?.yolo !== 'on') {
    if (!pull) return 'review-without-pull-evidence'
    if (attempt?.yolo === 'off') {
      const publication = readyHeadPublication(last ?? '')
      const head = publication && publication.id === releasePull(pull)?.id &&
        publication.id === releasePull(String(task?.pr.url))?.id && publication.head === requestedHead(task?.pr.head)
        ? publication.head : null
      return event({ target: 'Ready for Review', pull, head }, pull, `First Mate reported checks green. ${pull}`)
    }
    return 'merge-authority-unavailable'
  }
  if (task?.identity.spawn_gen && task.endpoint.exists !== false && task.endpoint.agent_alive !== 'dead' &&
    task.endpoint.status !== 'dead') {
    const liveness = retainedExecutionLiveness(task, now)
    if (codexTurn(task, now) === true || state && (liveness === 'running' ||
      liveness === 'liveness-not-observed' && state.state === 'working')) {
      return event({ target: 'In Progress' }, 'spawned', `First Mate worker ${id} is active (attempt ${task.identity.spawn_gen}).`)
    }
  }
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
    const label = source.label?.trim()
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
        const conflictingKeys = new Set([task?.[tswEvidence]?.dispatchProvenance, row?.[tswEvidence]?.dispatchProvenance]
          .flatMap(provenance => provenance?.status === 'card' ? [provenance.cardId] : []))
        for (const key of conflictingKeys) findings.push({ home, key, task: id, reason: 'conflicting-card-declarations' })
        continue
      }
      const key = dispatch.cardId
      if (!label) {
        findings.push({ home, key, task: id, reason: 'snapshot-label-missing' })
        continue
      }
      const signal = classify(id, task, row, now)
      if (typeof signal === 'string') {
        findings.push({ home, key, task: id, reason: signal })
        continue
      }
      const events = byKey.get(key) ?? []
      const completed = signal.details.target === 'Done'
      const subjectId = completed ? row?.id ?? id : id
      const generation = completed ? null : task?.identity.spawn_gen ?? null
      events.push({
        ...signal.details, ...authority(label), key, home, task: id, expiresAt: observation.expiresAt,
        id: eventId([home, subjectId, generation, signal.details.target, signal.witness]),
        evidence: signal.evidence,
      })
      byKey.set(key, events)
    }
  }
  const events: StatusEvent[] = []
  for (const [key, candidates] of byKey) {
    const [first, ...others] = candidates
    const head = first?.target === 'Ready for Review' ? first.head : null
    const pull = first?.target === 'Ready for Review' && head ? releasePull(first.pull) : null
    const equivalent = pull && others.every(candidate =>
      candidate.target === 'Ready for Review' && candidate.head === head && releasePull(candidate.pull)?.id === pull.id)
      ? pull : null
    const conflicting = findings.some(finding => finding.key === key && finding.reason === 'conflicting-card-declarations')
    if (first?.target === 'Ready for Review' && equivalent && !conflicting) {
      const ordered = [...candidates].sort((a, b) => a.id.localeCompare(b.id))
      const actors = [...new Set(ordered.map(candidate => candidate.actor))].sort()
      const expiresAt = ordered.flatMap(candidate => candidate.expiresAt ?? []).sort()[0] ?? null
      events.push({ ...first, owner: ordered[0]!.owner, pull: equivalent.url,
        actor: actors.join(', '), expiresAt, id: eventId([key, equivalent.url, head]) })
    } else if (first && !others.length && !conflicting) {
      events.push(first)
    } else {
      for (const candidate of candidates) findings.push({ key, home: candidate.home, task: candidate.task, reason: 'competing-task-events' })
    }
  }
  return { events: events.sort((a, b) => a.key.localeCompare(b.key, 'en', { numeric: true })), findings }
}

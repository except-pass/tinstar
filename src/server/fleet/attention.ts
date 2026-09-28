export type AttentionType = 'decision' | 'blocked' | 'failure' | 'review'
export type ReviewStatus = 'open' | 'merged' | 'closed' | 'unknown'

export interface AttentionCard {
  key: string
  type: AttentionType
  headline: string
  detail: string
  workerKey: string | null
  workerId: string | null
  ageDays: number | null
  prUrl: string | null
  repository: string | null
  prNumber: number | null
  reviewStatus: ReviewStatus | null
  ci: 'unknown'
}

export interface AttentionTask {
  id?: unknown
  hints?: { open_decisions?: Array<{ key?: unknown; verb?: unknown; summary?: unknown }> }
}

export interface AttentionBacklogRow {
  id?: unknown
  title?: unknown
  state?: unknown
  hold_kind?: unknown
  hold_reason?: unknown
  hold_age_days?: unknown
  merged?: unknown
  completion?: { verb?: unknown }
}

export interface AttentionWorker {
  key: string
  id: string
  objective: string
  state: string
  detail: string
  prUrl: string | null
}

export function parsePullUrl(value: string): { repository: string; number: number; apiPath: string } | null {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(value)
  if (!match) return null
  return { repository: `${match[1]}/${match[2]}`, number: Number(match[3]), apiPath: `/repos/${match[1]}/${match[2]}/pulls/${match[3]}` }
}

const word = (value: unknown, fallback: string): string => typeof value === 'string' && value.trim() ? value.trim() : fallback
const sameCallText = (left: string, right: unknown): boolean =>
  !!left.trim() && typeof right === 'string' && left.trim().toLowerCase() === right.trim().toLowerCase()
const holdMatchesDecision = (key: string, id: string): boolean =>
  key === id || key === `captain-hold-${id}` || key.startsWith(`captain-hold-${id}-`)

/** Projects First Mate's keyed calls and backlog holds without changing either source. */
export function buildAttentionCards(
  homeIndex: number,
  tasks: AttentionTask[],
  backlog: AttentionBacklogRow[],
  workers: AttentionWorker[],
  reviewStatuses: ReadonlyMap<string, ReviewStatus>,
): AttentionCard[] {
  const cards: AttentionCard[] = []
  const workerById = new Map(workers.map(worker => [worker.id, worker]))
  const holds = backlog.filter(row => row.state !== 'done' && row.hold_kind === 'captain' && typeof row.id === 'string' && row.id.trim())
  const matchedHolds = new Set<string>()
  const homeKey = `attention-${homeIndex}`

  for (const task of tasks) {
    const id = word(task.id, '')
    if (!id) continue
    const worker = workerById.get(id)
    if (!worker) continue
    const decisions = Array.isArray(task.hints?.open_decisions) ? task.hints.open_decisions : []
    let hasBlockedCall = false
    for (const entry of decisions) {
      if (entry.verb !== 'needs-decision' && entry.verb !== 'blocked') continue
      const key = word(entry.key, 'default')
      const type = entry.verb === 'blocked' ? 'blocked' : 'decision'
      if (type === 'blocked') hasBlockedCall = true
      const hold = holds.find(row => holdMatchesDecision(key, String(row.id)) ||
        ((row.id === id || String(row.id).startsWith(`${id}-`)) && sameCallText(word(entry.summary, ''), row.hold_reason)))
      if (hold) matchedHolds.add(String(hold.id))
      const summary = word(entry.summary, word(hold?.hold_reason, worker.detail))
      cards.push({
        key: `${homeKey}:${id}:${type}:${key}`, type,
        headline: summary, detail: summary, workerKey: worker.key, workerId: id,
        ageDays: typeof hold?.hold_age_days === 'number' ? hold.hold_age_days : null,
        prUrl: null, repository: null, prNumber: null, reviewStatus: null, ci: 'unknown',
      })
    }
    if (worker.state === 'blocked' && !hasBlockedCall) {
      cards.push({
        key: `${homeKey}:${id}:blocked:state`, type: 'blocked', headline: word(worker.detail, `${id} is blocked`),
        detail: word(worker.detail, 'What is needed is unknown'), workerKey: worker.key, workerId: id,
        ageDays: null, prUrl: null, repository: null, prNumber: null, reviewStatus: null, ci: 'unknown',
      })
    }
    if (worker.state === 'failed') {
      cards.push({
        key: `${homeKey}:${id}:failure`, type: 'failure', headline: word(worker.detail, `${id} failed`),
        detail: word(worker.detail, 'Failure detail unknown'), workerKey: worker.key, workerId: id,
        ageDays: null, prUrl: null, repository: null, prNumber: null, reviewStatus: null, ci: 'unknown',
      })
    }
  }

  for (const hold of holds) {
    const id = String(hold.id)
    if (matchedHolds.has(id)) continue
    // A backlog hold may predate its worker, or have its own id below a supervisor task.
    const worker = workerById.get(id) ?? workers.filter(item => id.startsWith(`${item.id}-`)).sort((a, b) => b.id.length - a.id.length)[0]
    const headline = word(hold.hold_reason, word(hold.title, 'Captain decision needed'))
    cards.push({
      key: `${homeKey}:hold:${id}`, type: 'decision', headline, detail: word(hold.title, headline),
      workerKey: worker?.key ?? null, workerId: worker?.id ?? null,
      ageDays: typeof hold.hold_age_days === 'number' ? hold.hold_age_days : null,
      prUrl: null, repository: null, prNumber: null, reviewStatus: null, ci: 'unknown',
    })
  }

  const seenPulls = new Set<string>()
  for (const worker of workers) {
    if (!worker.prUrl || seenPulls.has(worker.prUrl)) continue
    const parsed = parsePullUrl(worker.prUrl)
    if (!parsed) continue
    seenPulls.add(worker.prUrl)
    const row = backlog.find(item => item.id === worker.id)
    if (row?.merged || row?.completion?.verb === 'merged') continue
    const reviewStatus = reviewStatuses.get(worker.prUrl) ?? 'unknown'
    if (reviewStatus === 'merged' || reviewStatus === 'closed') continue
    cards.push({
      key: `${homeKey}:pr:${worker.prUrl}`, type: 'review', headline: worker.objective,
      detail: reviewStatus === 'unknown' ? 'Pull request status unavailable' : 'Ready for review',
      workerKey: worker.key, workerId: worker.id, ageDays: null,
      prUrl: worker.prUrl, repository: parsed.repository, prNumber: parsed.number, reviewStatus, ci: 'unknown',
    })
  }
  return cards
}

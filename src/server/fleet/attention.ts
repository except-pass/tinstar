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
  body_lines?: unknown
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
const distinct = (detail: string, headline: string): string => sameCallText(headline, detail) ? '' : detail
const holdOrigin = (row: AttentionBacklogRow): string | null => {
  const lines = Array.isArray(row.body_lines) ? row.body_lines : []
  for (const line of lines) {
    const match = typeof line === 'string' ? /^Origin:\s*(\S+)$/.exec(line.trim()) : null
    if (match) return match[1]!
  }
  return null
}

/** First Mate's own resolution order: exact id, legacy decision id, the published hold key, then one migrated-prefix row. */
function resolveHold(holds: AttentionBacklogRow[], taskId: string, key: string): AttentionBacklogRow | undefined {
  const legacy = `${taskId}-decision-${key}`
  const published = /^captain-hold-(.+)-\d+$/.exec(key)?.[1]
  for (const id of [key, legacy, published]) {
    const row = id && holds.find(item => item.id === id)
    if (row) return row
  }
  const migrated = holds.filter(item => [key, legacy].some(id => {
    const row = String(item.id)
    return row.endsWith(`-${id}`) && !row.slice(0, -id.length - 1).includes('-')
  }))
  return migrated.length === 1 ? migrated[0] : undefined
}

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
      const hold = resolveHold(holds, id, key) ?? holds.find(row => !matchedHolds.has(String(row.id)) &&
        (row.id === id || holdOrigin(row) === id) && sameCallText(word(entry.summary, ''), row.hold_reason))
      if (hold) matchedHolds.add(String(hold.id))
      const summary = word(entry.summary, word(hold?.hold_reason, worker.detail))
      cards.push({
        key: `${homeKey}:${id}:${type}:${key}`, type,
        headline: summary, detail: distinct(word(hold?.title, ''), summary), workerKey: worker.key, workerId: id,
        ageDays: typeof hold?.hold_age_days === 'number' ? hold.hold_age_days : null,
        prUrl: null, repository: null, prNumber: null, reviewStatus: null, ci: 'unknown',
      })
    }
    if (worker.state === 'blocked' && !hasBlockedCall) {
      const headline = word(worker.detail, `${id} is blocked`)
      cards.push({
        key: `${homeKey}:${id}:blocked:state`, type: 'blocked', headline,
        detail: distinct(word(worker.detail, 'unknown'), headline), workerKey: worker.key, workerId: id,
        ageDays: null, prUrl: null, repository: null, prNumber: null, reviewStatus: null, ci: 'unknown',
      })
    }
    if (worker.state === 'failed') {
      const headline = word(worker.detail, `${id} failed`)
      cards.push({
        key: `${homeKey}:${id}:failure`, type: 'failure', headline,
        detail: distinct(word(worker.detail, 'Failure detail unknown'), headline), workerKey: worker.key, workerId: id,
        ageDays: null, prUrl: null, repository: null, prNumber: null, reviewStatus: null, ci: 'unknown',
      })
    }
  }

  for (const hold of holds) {
    const id = String(hold.id)
    if (matchedHolds.has(id)) continue
    const origin = holdOrigin(hold)
    const worker = workerById.get(id) ?? (origin ? workerById.get(origin) : undefined)
    const headline = word(hold.hold_reason, word(hold.title, 'Captain decision needed'))
    cards.push({
      key: `${homeKey}:hold:${id}`, type: 'decision', headline, detail: distinct(word(hold.title, ''), headline),
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

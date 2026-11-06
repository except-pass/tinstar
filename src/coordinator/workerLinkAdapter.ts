import { createHash } from 'node:crypto'
import { buildWorkerLinkReport, type BackfillProposal } from '../server/reconciliation/workerLinkReport'
import type { SourceSnapshot } from '../server/reconciliation'
import { notionPageId } from '../server/reconciliation/notion'
import { FIRST_MATE_TASKS, isBlankWorkerLinks, readWorkerLinks, recoverWorkerLinks, workerLinkRecord, type WorkerLink, type WorkerLinks } from '../server/reconciliation/workerLinks'
import { record } from '../server/reconciliation/values'
import { declaredLinks } from '../server/reconciliation/scene'

export interface AdapterAudit {
  time: string
  cardId: string | null
  identities: WorkerLink[]
  beforeHash: string | null
  afterHash: string | null
  result: string
  investigationKey?: string
  priorText?: string
}
export interface AdapterOptions {
  apply?: boolean
  maxCards?: number
  cards?: string[]
  audit: (entry: AdapterAudit) => Promise<void>
  transport?: NotionLinkTransport
  now?: () => number
}
const identityKey = (link: WorkerLink) => JSON.stringify([link.fm_home, link.task_id])
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const asLink = (p: BackfillProposal): WorkerLink => ({ fm_home: p.fm_home, task_id: p.task_id, first_observed_spawn_gen: p.spawn_gen })

function mergeLinks(before: WorkerLinks, additions: WorkerLink[], text?: unknown) {
  const recovered = recoverWorkerLinks(before, text)
  if (before.status !== 'valid' && !isBlankWorkerLinks(before) && !recovered) throw new Error('unmergeable')
  const tasks = before.status === 'valid' ? [...before.tasks] : [...(recovered ?? [])]
  const priorText = recovered ? text as string : undefined
  const beforeHash = hash(priorText ?? (before.status === 'valid' ? workerLinkRecord(tasks).json : ''))
  for (const addition of additions) {
    const existing = tasks.find(task => identityKey(task) === identityKey(addition))
    if (existing && existing.first_observed_spawn_gen !== addition.first_observed_spawn_gen) throw new Error('generation-conflict')
    if (!existing) tasks.push(addition)
  }
  const merged = workerLinkRecord(tasks)
  return { merged, beforeHash, afterHash: hash(merged.json), priorText }
}

function adapterReport(input: SourceSnapshot) {
  const original = buildWorkerLinkReport(input)
  const repairs = new Set<string>()
  const cards = input.intentions.data?.cards.map(card => {
    const property = card.properties[FIRST_MATE_TASKS]
    const recovered = property?.type === 'rich_text' && !property.hasMore
      ? recoverWorkerLinks(declaredLinks(card), property.value) : undefined
    if (!recovered) return card
    repairs.add(card.id)
    return { ...card, properties: { ...card.properties, [FIRST_MATE_TASKS]: {
      ...property!, workerLinks: { status: 'valid' as const, tasks: recovered },
    } } }
  })
  if (!repairs.size) return original
  // Reclassify using every recoverable declaration, so sibling/competing links
  // participate in the same exact-identity safety rules as ordinary records.
  const report = buildWorkerLinkReport({ ...input, intentions: { ...input.intentions,
    data: { ...input.intentions.data!, cards: cards! } } }, repairs)
  report.findings.push(...original.findings.filter(f => f.detector === 'invalid-record' && f.cardIds.some(id => repairs.has(id))))
  return { ...report, coverage: { ...report.coverage,
    cards: original.coverage.cards.map(card => ({ ...card, repairable: repairs.has(card.cardId) })),
  } }
}

/** A coordinator runs one invocation per board at a time. No server route imports this writer. */
export async function runWorkerLinkAdapter(input: SourceSnapshot, options: AdapterOptions) {
  if (options.apply && (!Number.isInteger(options.maxCards) || options.maxCards! < 1 || options.maxCards! > 5)) {
    throw new Error('--apply requires --max-cards between 1 and 5')
  }
  if (options.apply && !options.transport) throw new Error('Apply transport required')
  const now = options.now ?? Date.now
  // Age the saved coverage again at execution, rather than trusting an old report.
  const report = adapterReport({ ...input, generatedAt: new Date(now()).toISOString() })
  const filters = options.cards?.map(id => {
    const normalized = notionPageId(id)
    if (!normalized) throw new Error('Invalid --card id')
    return normalized
  })
  const decisions: AdapterAudit[] = []
  const plannedWrites: Array<{ cardId: string; properties: ReturnType<typeof workerLinkRecord>['properties'] }> = []
  async function audit(cardId: string | null, identities: WorkerLink[], result: string, beforeHash: string | null = null,
    afterHash: string | null = null, investigationKey?: string, priorText?: string) {
    const entry = { time: new Date(now()).toISOString(), cardId, identities, beforeHash, afterHash, result,
      ...(investigationKey ? { investigationKey } : {}), ...(priorText === undefined ? {} : { priorText }) }
    await options.audit(entry)
    decisions.push(entry)
  }
  // Stable investigation keys route repeated reports into one coordinator episode;
  // the adapter never creates Notion cards or sends supervision messages itself.
  for (const home of report.homes) for (const [tier, rows] of Object.entries(home.tiers)) {
    if (tier === 'eligible auto-write') continue
    for (const row of rows) {
      const links = row.task_id && row.spawn_gen ? [{ fm_home: home.fm_home, task_id: row.task_id, first_observed_spawn_gen: row.spawn_gen }] : []
      await audit(row.cardIds.length === 1 ? row.cardIds[0]! : null, links, tier,
        null, null, ['conflicts', 'ambiguous', 'unavailable'].includes(tier) ? JSON.stringify(['worker', home.fm_home, row.task_id]) : undefined)
    }
  }
  for (const finding of report.findings.filter(f => f.detector === 'invalid-record')) {
    for (const cardId of finding.cardIds) {
      const text = input.intentions.data?.cards.find(c => c.id === cardId)?.properties[FIRST_MATE_TASKS]?.value
      await audit(cardId, [], 'investigate-invalid-record', typeof text === 'string' ? hash(text) : null,
        null, JSON.stringify(['card', cardId]), typeof text === 'string' ? text : undefined)
    }
  }
  const eligible = report.homes.flatMap(home => home.tiers['eligible auto-write'].flatMap(row => row.proposals))
  const cardIds = [...new Set(eligible.map(p => p.cardId))].sort()
  let processed = 0, workers = 0, stopped = false
  for (const cardId of cardIds) {
    const additions = eligible.filter(p => p.cardId === cardId).map(asLink)
    if (filters && !filters.includes(cardId)) { await audit(cardId, additions, 'filtered'); continue }
    if (options.apply && (processed >= options.maxCards! || workers + additions.length > 10)) {
      await audit(cardId, additions, 'batch-limit'); continue
    }
    if (!options.apply) {
      const card = input.intentions.data!.cards.find(c => c.id === cardId)!
      try {
        const plan = mergeLinks(declaredLinks(card), additions, card.properties[FIRST_MATE_TASKS]?.value)
        plannedWrites.push({ cardId, properties: plan.merged.properties })
        await audit(cardId, additions, 'planned', plan.beforeHash, plan.afterHash, undefined, plan.priorText)
      } catch { await audit(cardId, additions, 'stop-prewrite-conflict', null, null, JSON.stringify(['card', cardId])) }
      continue
    }
    processed += 1; workers += additions.length
    const transport = options.transport!
    let beforeHash: string | null = null, afterHash: string | null = null
    let attempted = false
    try {
      const assertEligible = () => {
        const current = adapterReport({ ...input, generatedAt: new Date(now()).toISOString() })
        const stillEligible = current.homes.flatMap(h => h.tiers['eligible auto-write'].flatMap(r => r.proposals))
        if (additions.some(link => !stillEligible.some(p => p.cardId === cardId && JSON.stringify(asLink(p)) === JSON.stringify(link)))) throw new Error('coverage-expired')
      }
      assertEligible()
      const before = await transport.read(cardId)
      if (before.links.status === 'invalid') {
        if (!report.findings.some(f => f.detector === 'invalid-record' && f.cardIds.includes(cardId))) {
          report.findings.push({ detector: 'invalid-record', classification: 'unverified-conflicting', cardIds: [cardId],
            executionIds: [], homeIds: [], reason: `${FIRST_MATE_TASKS}: ${before.links.reason}` })
        }
        await audit(cardId, [], 'investigate-invalid-record', typeof before.text === 'string' ? hash(before.text) : null,
          null, JSON.stringify(['card', cardId]), before.text)
      }
      const plan = mergeLinks(before.links, additions, before.text)
      const { merged } = plan
      beforeHash = plan.beforeHash; afterHash = plan.afterHash
      if (beforeHash === afterHash) { await audit(cardId, additions, 'no-op', beforeHash, afterHash); continue }
      // Durable audit must succeed before the property PATCH can begin.
      await audit(cardId, additions, 'write-planned', beforeHash, afterHash, undefined, plan.priorText)
      await transport.write(cardId, merged.properties, () => {
        assertEligible()
        attempted = true
      })
      const after = await transport.read(cardId)
      if (after.links.status !== 'valid' || workerLinkRecord(after.links.tasks).json !== merged.json) throw new Error('readback-mismatch')
      await audit(cardId, additions, 'verified', beforeHash, afterHash)
    } catch {
      await audit(cardId, additions, attempted ? 'stop-uncertain-write' : 'stop-prewrite-conflict', beforeHash, afterHash, JSON.stringify(['card', cardId]))
      stopped = true
      break
    }
  }
  return { mode: options.apply ? 'apply' : 'report-only', stopped, plannedWrites, decisions, report }
}

export interface NotionLinkTransport {
  read(cardId: string): Promise<{ links: WorkerLinks; text?: string }>
  write(cardId: string, properties: ReturnType<typeof workerLinkRecord>['properties'], beforePatch: () => void): Promise<void>
}

/** The only credential-bearing component. Errors are fixed messages, never remote bodies. */
export function notionLinkTransport(token: string, dataSourceId: string, fetcher: typeof fetch = fetch,
  timing: { now: () => number; sleep: (ms: number) => Promise<void> } = { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) }): NotionLinkTransport {
  const board = notionPageId(dataSourceId)
  if (!board || !token.trim() || /[\r\n]/.test(token)) throw new Error('Invalid adapter credentials or board')
  let lastWrite = -Infinity
  async function request(path: string, method = 'GET', body?: unknown, beforePatch?: () => void) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (method === 'PATCH') {
        await timing.sleep(Math.max(0, lastWrite + 1000 - timing.now()))
        beforePatch!()
        lastWrite = timing.now()
      }
      const response = await fetcher(`https://api.notion.com/v1/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      if (response.status === 429 && attempt < 2) {
        const value = response.headers.get('Retry-After')
        const seconds = value === null || value.trim() === '' ? NaN : Number(value)
        const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value ?? '') - timing.now()
        await response.body?.cancel()
        // Never retry sooner than requested; excessive/unknown delays stop this invocation.
        if (!Number.isFinite(delay) || delay < 0 || delay > 30_000) throw new Error('Notion retry budget exceeded')
        await timing.sleep(delay)
        continue
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('Notion adapter request failed') }
      if (method === 'PATCH') { await response.body?.cancel(); return {} }
      const reader = response.body?.getReader()
      if (!reader) throw new Error('Notion response missing')
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > 4 * 1024 * 1024) throw new Error('Notion response too large')
          chunks.push(value)
        }
      } finally { await reader.cancel().catch(() => {}) }
      return record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    }
    throw new Error('Notion retry budget exceeded')
  }
  return {
    async read(cardId) {
      if (!notionPageId(cardId)) throw new Error('Invalid card id')
      const page = await request(`pages/${cardId}`)
      const parent = record(page.parent)
      const properties = record(page.properties)
      const status = record(properties.Status)
      const statusName = record(status[status.type as string]).name
      if (page.object !== 'page' || notionPageId(page.id) !== cardId || notionPageId(parent.data_source_id) !== board ||
        page.archived !== false || page.in_trash !== false || typeof statusName !== 'string' || ['done', 'archived'].includes(statusName.toLowerCase())) {
        throw new Error('Card is outside the operational board')
      }
      const property = record(properties[FIRST_MATE_TASKS])
      if (property.type !== 'rich_text' || typeof property.id !== 'string') throw new Error('Property unreadable')
      // Always retrieve the full property, including when the page inline list appears blank.
      // Notion returns percent-encoded property ids; normalize without double encoding.
      const propertyPath = encodeURIComponent(decodeURIComponent(property.id))
      const items: unknown[] = []
      let cursor: string | undefined
      for (let attempt = 0; attempt < 100; attempt++) {
        const query = new URLSearchParams({ page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) })
        const body = await request(`pages/${cardId}/properties/${propertyPath}?${query}`)
        if (body.object !== 'list' || !Array.isArray(body.results) || typeof body.has_more !== 'boolean') throw new Error('Property unreadable')
        for (const value of body.results) {
          const row = record(value)
          if (row.type !== 'rich_text') throw new Error('Property unreadable')
          items.push(row.rich_text)
        }
        if (items.length > 100) throw new Error('Property exceeds Notion limits')
        if (!body.has_more) return { links: readWorkerLinks({ type: 'rich_text', rich_text: items }),
          text: items.map(item => { const rich = record(item); return rich.plain_text ?? record(rich.text).content }).join('') }
        if (typeof body.next_cursor !== 'string' || !body.next_cursor || body.next_cursor === cursor) throw new Error('Property pagination incomplete')
        cursor = body.next_cursor
      }
      throw new Error('Property pagination incomplete')
    },
    async write(cardId, properties, beforePatch) {
      await request(`pages/${cardId}`, 'PATCH', { properties: { [FIRST_MATE_TASKS]: properties[FIRST_MATE_TASKS] } }, beforePatch)
    },
  }
}

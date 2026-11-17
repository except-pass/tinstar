import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { bindingMeaning, dependencyIdentity, decisionPacketSchema, type DecisionEvidence } from '../../shared/decisionPacket'
import { DecisionDeskConflict, packetContentHash, type DecisionPackets } from './decisionPackets'
import { commentPacketActor, commentPacketSource, newestCommentPackets } from './commentPacket'
import type { CardContextRead } from './cardContext'

const exec = promisify(execFile)
const attemptMs = 10 * 60 * 1000
/** One Clavis bundle. `url` and `key` are fields, not separate secret names. */
export const prepSecretName = 'grok/tinstar-decision-prep'
export const preparerName = 'Tinstar Decision Prep'
export const webhookMissing = 'The preparer webhook is not configured.'

export interface PrepCandidate {
  card_id: string; request_id: string; source_revision: string; card_url: string
  card_status: string | null; answered: boolean; leased: boolean; reasons: string[]; rank: number
}
export interface PreparationJob {
  id: string; card_id: string; request_id: string; source_revision: string; card_url: string
  published_at?: string | null; readiness?: { ready: boolean; reasons: string[] }
  state: string; reason: string; actor: string; mode: string; attempt: number; packet_id: string | null
}
export interface RefillPass {
  at: string; outcome: string; explanation: string; coverage: 'complete' | 'unknown'
  requests: number | null; candidates: number; cards: number; ready: number; inflight: number
  target: number; free_slots: number; admitted: number; bot_failures: number; bot_errors: string[]
  source_failures: Array<{ card_id: string; reasons: string[] }>
  rejections: Array<{ outcome: string; explanation: string; count: number }>
}
export interface PreparationReport {
  configured: boolean; preparer: string; explanation: string; preparing: number
  automatic_replenishment: boolean
  jobs: PreparationJob[]
  refill_pass?: RefillPass
}
export interface PrepareResult { outcome: string; explanation: string; job_id?: string; state?: string }

type Secret = { url: string; key: string }
type Row = PreparationJob & { scope: string; created_at: string; updated_at: string; dispatched_at: string | null }

/** Read one Clavis bundle as JSON. Failures and empty results are absence; stdout is never logged. */
export async function readClavisValue(name: string): Promise<string | null> {
  try {
    const { stdout } = await exec('clavis', ['get', name, '--format=json'], { timeout: 15_000, encoding: 'utf8', maxBuffer: 8192 })
    const value = stdout.trim()
    return value || null
  } catch { return null }
}

function prepSecret(raw: string | null): Secret | null {
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const record = parsed as Record<string, unknown>
  const url = webhookUrl(typeof record.url === 'string' ? record.url : '')
  const key = typeof record.key === 'string' ? record.key.trim() : ''
  return url && key ? { url, key } : null
}

function webhookUrl(value: string): string | null {
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch { return null }
}

/** One webhook job per eligible decision. The bot publishes back through the
 * packet store; this class never answers, claims a lease, or changes card status.
 * No token ceiling or spend record is kept. */
export class DecisionPreparation {
  private initialized?: Promise<void>
  private secret: Secret | null = null
  private loadedAt = 0
  private loading?: Promise<void>
  private replenishing?: Promise<void>
  private replenishAgain = false
  private automatic = false
  private lastPass?: RefillPass
  constructor(readonly packets: DecisionPackets, readonly scope: string, private source: { candidates(cardId?: string): PrepCandidate[] | Promise<PrepCandidate[]>; renew?(): Promise<void>; coverage(): 'complete' | 'unknown'; diagnostics?(): { requests: number | null; source_failures: RefillPass['source_failures'] } },
    private evidence: (cardId: string) => DecisionEvidence, private readSecret: (name: string) => Promise<string | null> = readClavisValue,
    private now = Date.now, private fetchImpl: typeof fetch = fetch) {}

  private initialize() {
    return this.initialized ??= this.packets.initialize().then(() => this.packets.leases.writeStorage(db => { db.exec(`
      CREATE TABLE IF NOT EXISTS decision_prep_jobs (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, card_id TEXT NOT NULL, request_id TEXT NOT NULL,
        source_revision TEXT NOT NULL, card_url TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL,
        actor TEXT NOT NULL, mode TEXT NOT NULL, operation_id TEXT NOT NULL, attempt INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, dispatched_at TEXT, packet_id TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS decision_prep_active
        ON decision_prep_jobs(scope, card_id, request_id, source_revision)
        WHERE state IN ('admitted', 'dispatched');
      CREATE INDEX IF NOT EXISTS decision_prep_revision ON decision_prep_jobs(scope, card_id, request_id, source_revision);`)
      const columns = db.prepare('PRAGMA table_info(decision_prep_jobs)').all() as Array<{ name: string }>
      if (!columns.some(column => column.name === 'published_at')) db.exec('ALTER TABLE decision_prep_jobs ADD COLUMN published_at TEXT')
      // Recover successful legacy jobs even if later evidence/lease changes made
      // their state blocked or failed. Validation events retain the real time.
      db.exec(`UPDATE decision_prep_jobs SET published_at = (
        SELECT min(e.at) FROM decision_packet_events e JOIN decision_packet_validations v ON v.sequence = e.sequence
        WHERE e.packet_id = decision_prep_jobs.packet_id AND v.valid = 1)
        WHERE published_at IS NULL AND packet_id IS NOT NULL;
        UPDATE decision_prep_jobs SET reason = CASE WHEN state != 'published' THEN 'Packet published successfully; see current readiness for validation or lease restrictions.' ELSE reason END, state = 'published' WHERE published_at IS NOT NULL AND state != 'superseded';`)
    }))
  }

  private async ensureConfig() {
    if (this.loadedAt && this.now() - this.loadedAt < 30_000) return
    this.loading ??= this.readConfig().finally(() => { this.loading = undefined })
    await this.loading
  }

  private async readConfig() {
    try {
      this.secret = prepSecret(await this.readSecret(prepSecretName))
    } catch { this.secret = null }
    this.loadedAt = this.now()
  }

  private rows(db: DatabaseSync) {
    return db.prepare('SELECT * FROM decision_prep_jobs WHERE scope = ? ORDER BY created_at DESC, attempt DESC, id DESC').all(this.scope) as unknown as Row[]
  }

  private inflight(db: DatabaseSync) {
    return Number((db.prepare("SELECT count(*) AS n FROM decision_prep_jobs WHERE scope = ? AND state IN ('admitted','dispatched')").get(this.scope) as { n: number }).n)
  }

  private readyCount(db: DatabaseSync) {
    const rows = db.prepare('SELECT id FROM decision_packets p WHERE version = (SELECT max(version) FROM decision_packets WHERE source_key = p.source_key)').all() as Array<{ id: string }>
    let ready = 0
    for (const row of rows) {
      const preview = this.packets.readInStorage(db, row.id)
      if (!preview) continue
      if (this.packets.readInStorage(db, row.id, this.evidence(preview.packet.binding.card_id))?.ready) ready += 1
    }
    return ready
  }

  private readyRevision(db: DatabaseSync, candidate: PrepCandidate) {
    const rows = db.prepare('SELECT id FROM decision_packets p WHERE version = (SELECT max(version) FROM decision_packets WHERE source_key = p.source_key)').all() as Array<{ id: string }>
    return rows.some(row => {
      const preview = this.packets.readInStorage(db, row.id)
      if (!preview || preview.packet.binding.card_id !== candidate.card_id || preview.packet.binding.request_id !== candidate.request_id || preview.packet.binding.source_revision !== candidate.source_revision) return false
      return !!this.packets.readInStorage(db, row.id, this.evidence(candidate.card_id))?.ready
    })
  }

  private expire(db: DatabaseSync) {
    const cutoff = new Date(this.now() - attemptMs).toISOString()
    db.prepare("UPDATE decision_prep_jobs SET state = 'failed', reason = ?, updated_at = ? WHERE scope = ? AND state IN ('admitted','dispatched','blocked') AND published_at IS NULL AND coalesce(dispatched_at, created_at) < ?")
      .run('Preparer did not publish a valid packet before the attempt expired. A late publication can still complete this job.', new Date(this.now()).toISOString(), this.scope, cutoff)
  }

  private held(db: DatabaseSync, card: string) {
    return this.packets.leases.activeInStorage(this.packets.leases.rowInStorage(db, card)) || this.packets.leases.reviewReservedInStorage(db, card)
  }

  private refusal(candidate: PrepCandidate): string | null {
    if (candidate.answered) return 'This source request already has an answer.'
    if (candidate.leased) return 'A reviewer holds this card. Preparation does not claim or replace that lease.'
    if (candidate.card_status === 'Todo') return 'Todo work is not prepared to fill the queue.'
    if (!candidate.request_id || !candidate.source_revision) return 'This decision has no exact source request to prepare.'
    if (candidate.reasons.length) return candidate.reasons[0]!
    return null
  }

  private admit(db: DatabaseSync, candidate: PrepCandidate, mode: 'automatic' | 'prepare-now', actor: string, reason: string): PrepareResult & { job?: Row } {
    this.expire(db)
    const blocked = this.refusal(candidate)
    if (blocked) return { outcome: 'ineligible', explanation: blocked }
    if (this.held(db, candidate.card_id)) return { outcome: 'ineligible', explanation: 'A reviewer holds this card. Preparation does not claim or replace that lease.' }
    if (this.readyRevision(db, candidate)) return { outcome: 'already-ready', explanation: 'This decision revision is already ready for review.' }
    const prior = db.prepare(`SELECT * FROM decision_prep_jobs WHERE scope = ? AND card_id = ? AND request_id = ? AND source_revision = ?
      ORDER BY created_at DESC, attempt DESC, id DESC LIMIT 1`).get(this.scope, candidate.card_id, candidate.request_id, candidate.source_revision) as Row | undefined
    if (prior && ['admitted', 'dispatched'].includes(prior.state)) return { outcome: 'already-preparing',
      explanation: 'This decision revision is already being prepared.', job_id: prior.id, state: prior.state }
    const stored = db.prepare(`SELECT p.body FROM decision_packets p
      WHERE json_extract(body,'$.binding.card_id') = ? AND json_extract(body,'$.binding.request_id') = ?
      AND json_extract(body,'$.binding.source_revision') = ?
      AND version = (SELECT max(version) FROM decision_packets WHERE source_key = p.source_key)
      AND EXISTS (SELECT 1 FROM decision_packet_validations WHERE packet_id = p.id AND valid = 1)
      AND NOT EXISTS (SELECT 1 FROM decision_packet_events WHERE packet_id = p.id AND type = 'research-requested')`)
      .all(candidate.card_id, candidate.request_id, candidate.source_revision) as Array<{ body: string }>
    const sources = this.evidence(candidate.card_id).requests.filter(request => request.binding?.request_id === candidate.request_id)
    const source = sources.length === 1 ? sources[0] : undefined
    const unchanged = stored.some(row => {
      const packet = decisionPacketSchema.parse(JSON.parse(row.body))
      if (!source?.binding || bindingMeaning(source.binding) !== bindingMeaning(packet.binding) || source.question !== packet.question) return false
      const current = new Map(source.dependencies.map(dependency => [dependencyIdentity(dependency), dependency.revision]))
      return current.size === packet.dependencies.length && packet.dependencies.every(dependency =>
        !!dependency.revision && current.get(dependencyIdentity(dependency)) === dependency.revision)
    })
    if (unchanged) return { outcome: 'already-prepared', explanation: 'This unchanged revision has a published packet; refresh source evidence to revalidate it.' }
    const policy = this.packets.policyInStorage(db, this.scope)
    const inflight = this.inflight(db)
    if (inflight >= policy.values.max_preparers) return { outcome: 'at-capacity', explanation: 'All preparer slots are in use. Wait for a job to finish or raise the maximum parallel preparers.' }
    if (mode === 'automatic' && (policy.values.automatic_replenishment !== true || this.readyCount(db) + inflight >= policy.values.target_ready)) return { outcome: 'depth-met', explanation: 'Ready decisions and in-flight jobs already fill the target depth.' }
    const id = randomUUID(), at = new Date(this.now()).toISOString()
    const job: Row = { id, scope: this.scope, card_id: candidate.card_id, request_id: candidate.request_id, source_revision: candidate.source_revision, card_url: candidate.card_url,
      state: 'admitted', reason: 'Admitted for preparation.', actor, mode, attempt: (prior?.attempt ?? 0) + 1, packet_id: null, created_at: at, updated_at: at, dispatched_at: null }
    db.prepare("UPDATE decision_prep_jobs SET state = 'superseded', reason = 'Replaced by a newer preparation attempt.', updated_at = ? WHERE scope = ? AND card_id = ? AND request_id = ? AND source_revision = ?")
      .run(at, this.scope, candidate.card_id, candidate.request_id, candidate.source_revision)
    db.prepare('INSERT INTO decision_prep_jobs (id,scope,card_id,request_id,source_revision,card_url,state,reason,actor,mode,operation_id,attempt,created_at,updated_at,dispatched_at,packet_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, this.scope, candidate.card_id, candidate.request_id, candidate.source_revision, candidate.card_url, 'admitted', job.reason, actor, mode, `prep-${id}`, job.attempt, at, at, null, null)
    db.prepare('INSERT INTO decision_packet_events(packet_id,type,actor,at,detail) VALUES(?,?,?,?,?)').run(null, mode === 'prepare-now' ? 'prepare-now' : 'prep-admit', actor, at, JSON.stringify({ job_id: id, card_id: candidate.card_id, request_id: candidate.request_id, reason }))
    return { outcome: 'admitted', explanation: job.reason, job_id: id, state: 'admitted', job }
  }

  private async mark(id: string, state: string, reason: string) {
    await this.initialize()
    await this.packets.leases.writeStorage(db => db.prepare(`UPDATE decision_prep_jobs SET state = ?, reason = ?, updated_at = ?,
      dispatched_at = CASE WHEN ? = 'dispatched' THEN ? ELSE dispatched_at END WHERE id = ? AND (state = 'admitted' OR (state = 'dispatched' AND ? != 'dispatched'))`).run(state, reason, new Date(this.now()).toISOString(), state, new Date(this.now()).toISOString(), id, state))
  }

  private async dispatch(job: Row) {
    const secret = this.secret
    if (!secret) { await this.mark(job.id, 'failed', webhookMissing); return }
    const payload = { request_id: job.request_id, card_url: job.card_url, publish: { tool: 'publish_prepared_packet', job_id: job.id } }
    try {
      const response = await this.fetchImpl(secret.url, {
        method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret.key}` },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
      })
      await response.arrayBuffer().catch(() => undefined)
      if (!response.ok) { await this.mark(job.id, 'failed', `Preparer webhook rejected the job (HTTP ${response.status}).`); return }
      await this.mark(job.id, 'dispatched', 'Sent to the Tinstar Decision Prep bot.')
    } catch { await this.mark(job.id, 'failed', 'Preparer webhook could not be reached.') }
  }

  async status(cachedOnly = false): Promise<PreparationReport> {
    if (cachedOnly) void this.ensureConfig().catch(() => {})
    else await this.ensureConfig()
    await this.initialize()
    const policy = await this.packets.readPolicy(this.scope)
    this.automatic = policy.values.automatic_replenishment
    const jobs = this.packets.leases.readStorage(db => this.rows(db))
    const preparing = jobs.filter(job => job.state === 'admitted' || job.state === 'dispatched').length
    const problem = jobs.find(job => job.state === 'failed' || job.state === 'blocked')
    let explanation = !this.loadedAt && this.loading ? 'Checking preparer configuration.' : webhookMissing
    if (this.secret) explanation = policy.values.automatic_replenishment
      ? `${preparerName} is the preparer. Automatic replenishment is on.`
      : `${preparerName} is the preparer. Automatic replenishment is off until you turn it on.`
    if (this.secret && problem && !this.lastPass) explanation += ` Latest problem: ${problem.reason}`
    if (this.secret && this.lastPass) explanation += ` Last refill: ${this.lastPass.explanation}`
    return { configured: !!this.secret, preparer: preparerName, explanation, preparing, automatic_replenishment: policy.values.automatic_replenishment,
      refill_pass: this.lastPass,
      jobs: jobs.map(({ id, card_id, request_id, source_revision, card_url, state, reason, actor, mode, attempt, packet_id, published_at }) => ({ id, card_id, request_id, source_revision, card_url, state, reason, actor, mode, attempt, packet_id, published_at,
        readiness: packet_id ? this.packets.leases.readStorage(db => {
          const current = this.packets.readInStorage(db, packet_id, this.evidence(card_id))
          return { ready: !!current?.ready, reasons: current?.reasons ?? ['Packet is unavailable'] }
        }) : undefined })) }
  }

  /** Automatic fill only. Explicit Prepare now is separate and works while this is off. */
  historyLoaded() {
    // A display-only read with replenishment off must not start a SQLite
    // writer pass for every card in the board.
    if (this.automatic) void this.replenish()
  }

  replenish(): Promise<void> {
    if (this.replenishing) { this.replenishAgain = true; return this.replenishing }
    this.replenishing = (async () => {
      do {
        this.replenishAgain = false
        await this.replenishOnce()
      } while (this.replenishAgain)
    })().finally(() => { this.replenishing = undefined })
    return this.replenishing
  }

  private async replenishOnce() {
    const pass: RefillPass = { at: new Date(this.now()).toISOString(), outcome: 'source-failure', explanation: 'Source observation could not be read; the next pass will retry.',
      coverage: 'unknown', requests: null, candidates: 0, cards: 0, ready: 0, inflight: 0, target: 0, free_slots: 0, admitted: 0, bot_failures: 0, bot_errors: [], source_failures: [], rejections: [] }
    try {
      await this.ensureConfig()
      await this.initialize()
      const policy = await this.packets.readPolicy(this.scope)
      this.automatic = policy.values.automatic_replenishment
      await this.packets.leases.writeStorage(db => this.expire(db))
      pass.target = policy.values.target_ready
      await this.source.renew?.()
      pass.coverage = this.source.coverage()
      // Warm exact evidence even when collection coverage is temporarily unknown.
      // No source read or network dispatch occurs inside the storage transaction.
      const candidates = this.secret && this.automatic ? await this.source.candidates() : []
      pass.coverage = this.source.coverage()
      const diagnostics = this.source.diagnostics?.()
      pass.requests = diagnostics?.requests ?? null
      pass.source_failures = diagnostics?.source_failures ?? []
      pass.candidates = candidates.length
      pass.cards = new Set(candidates.map(candidate => candidate.card_id)).size
      const admitted: Row[] = []
      if (!this.secret) { pass.outcome = 'not-configured'; pass.explanation = webhookMissing }
      else if (!this.automatic) { pass.outcome = 'off'; pass.explanation = 'Automatic replenishment is off.' }
      else if (pass.coverage !== 'complete') { pass.outcome = 'coverage-unknown'; pass.explanation = 'Source coverage is incomplete; demand is unknown.' }
      else {
        for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank)) {
          const result = await this.packets.leases.writeStorage(db => this.admit(db, candidate, 'automatic', 'decision-desk', 'Automatic replenishment'))
          if (result.job && result.outcome === 'admitted') admitted.push(result.job)
          else {
            const prior = pass.rejections.find(row => row.outcome === result.outcome && row.explanation === result.explanation)
            if (prior) prior.count++
            else pass.rejections.push({ outcome: result.outcome, explanation: result.explanation, count: 1 })
          }
        }
        for (const job of admitted) await this.dispatch(job)
        pass.admitted = admitted.length
        const failures = this.packets.leases.readStorage(db => this.rows(db).filter(job => admitted.some(row => row.id === job.id) && job.state === 'failed'))
        pass.bot_failures = failures.length
        pass.bot_errors = [...new Set(failures.map(job => job.reason))]
        pass.outcome = pass.bot_failures ? 'bot-failure' : admitted.length ? 'dispatched' : 'no-admissible-work'
        pass.explanation = `${admitted.length} admitted from ${pass.candidates} exact source requests on ${pass.cards} cards. `
          + (pass.requests === null ? 'Total demand is unknown. ' : '')
          + pass.rejections.map(row => `${row.count}: ${row.explanation}`).join(' ')
          + (pass.source_failures.length ? ` Source evidence unavailable for ${pass.source_failures.length} cards.` : '')
          + (pass.bot_failures ? ` ${pass.bot_failures} webhook failures: ${pass.bot_errors.join(' ')}` : '')
          + (!candidates.length && pass.requests !== null && !pass.source_failures.length ? ' Exact sources are exhausted.' : '')
      }
      this.packets.leases.readStorage(db => {
        pass.ready = this.readyCount(db); pass.inflight = this.inflight(db)
        pass.free_slots = Math.max(0, policy.values.max_preparers - pass.inflight)
      })
      pass.explanation += ` Ready ${pass.ready}, in flight ${pass.inflight}, free slots ${pass.free_slots}, target ${pass.target}.`
    } catch {
      pass.explanation = 'Source observation could not be read; the next pass will retry.'
      // Source failures are distinct from a bot rejecting an admitted dispatch.
      pass.outcome = 'source-failure'
    }
    this.lastPass = pass
  }

  /** Revalidate stored packets using real freshly read evidence; never prepare anew. */
  async revalidate(cardId: string) {
    await this.initialize()
    const evidence = this.evidence(cardId)
    const answered = evidence.requests.filter(request => request.answered && request.binding)
    if (answered.length) await this.packets.leases.writeStorage(db => {
      for (const request of answered) {
        db.prepare(`UPDATE decision_prep_jobs SET state = 'cancelled', reason = 'Source request answered; preparation suppressed.', updated_at = ?
          WHERE scope = ? AND card_id = ? AND request_id = ? AND source_revision = ? AND published_at IS NULL AND state IN ('admitted','dispatched','blocked')`)
          .run(new Date(this.now()).toISOString(), this.scope, cardId, request.binding!.request_id, request.binding!.source_revision)
      }
    })
    const ids = this.packets.leases.readStorage(db => (db.prepare(`SELECT id FROM decision_packets p
      WHERE json_extract(body,'$.binding.card_id') = ? AND version = (SELECT max(version) FROM decision_packets WHERE source_key = p.source_key)`)
      .all(cardId) as Array<{ id: string }>).map(row => row.id))
    for (const id of ids) {
      const validation = await this.packets.validate(id, evidence, 'decision-desk')
      if (validation.valid) await this.packets.leases.writeStorage(db => {
        db.prepare(`UPDATE decision_prep_jobs SET state = 'published', published_at = coalesce(published_at, ?),
          reason = CASE WHEN published_at IS NULL THEN 'Published packet validated against refreshed source evidence.' ELSE reason END
          WHERE scope = ? AND packet_id = ? AND state != 'superseded'`).run(new Date(this.now()).toISOString(), this.scope, id)
      })
    }
  }

  /** Bounded priority set: in-flight exact jobs, then current reviewable packets. */
  async priorityCards() {
    await this.initialize()
    return this.packets.leases.readStorage(db => {
      const policy = this.packets.policyInStorage(db, this.scope)
      const jobs = this.rows(db).filter(job => ['admitted', 'dispatched'].includes(job.state)).map(job => job.card_id)
      const packets = db.prepare(`SELECT json_extract(body,'$.binding.card_id') AS card FROM decision_packets p
        WHERE version = (SELECT max(version) FROM decision_packets WHERE source_key = p.source_key)
        AND NOT EXISTS (SELECT 1 FROM decision_packet_events WHERE packet_id = p.id AND type IN ('research-requested','answer-confirmed'))
        ORDER BY EXISTS (SELECT 1 FROM decision_packet_validations WHERE packet_id = p.id AND valid = 1) DESC, published_at DESC`).all() as Array<{ card: string }>
      const reviewable = packets.map(row => row.card).filter(card => {
        const evidence = this.evidence(card)
        return !evidence.reasons.includes('Source card is closed') && (!evidence.requests.length || evidence.requests.some(request => !request.answered))
      })
      return [...new Set([...jobs, ...reviewable])].slice(0, policy.values.target_ready + policy.values.max_preparers)
    })
  }

  async prepareNow(actor: string, input: unknown): Promise<PrepareResult> {
    const request = z.object({ card_id: z.string().min(1).max(256), request_id: z.string().min(1).max(128), reason: z.string().trim().min(1).max(1000) }).strict().parse(input)
    z.string().trim().min(1).max(200).parse(actor)
    await this.ensureConfig()
    await this.initialize()
    if (!this.secret) {
      await this.packets.recordEvent(actor, 'prepare-now', { outcome: 'not-configured', card_id: request.card_id, request_id: request.request_id, reason: request.reason })
      return { outcome: 'not-configured', explanation: webhookMissing }
    }
    const candidate = (await this.source.candidates(request.card_id)).find(row => row.card_id === request.card_id && row.request_id === request.request_id)
    if (!candidate) {
      await this.packets.recordEvent(actor, 'prepare-now', { outcome: 'ineligible', card_id: request.card_id, request_id: request.request_id, reason: request.reason })
      return { outcome: 'ineligible', explanation: 'That decision is not in the current source observation.' }
    }
    const admitted = await this.packets.leases.writeStorage(db => this.admit(db, candidate, 'prepare-now', actor, request.reason))
    if (!admitted.job || admitted.outcome !== 'admitted') {
      if (admitted.outcome !== 'already-preparing') await this.packets.recordEvent(actor, 'prepare-now', { outcome: admitted.outcome, card_id: request.card_id, request_id: request.request_id, reason: request.reason, explanation: admitted.explanation })
      return { outcome: admitted.outcome, explanation: admitted.explanation, job_id: admitted.job_id, state: admitted.state }
    }
    await this.dispatch(admitted.job)
    const job = await this.packets.leases.readStorage(db => db.prepare('SELECT * FROM decision_prep_jobs WHERE id = ?').get(admitted.job!.id) as unknown as Row)
    return { outcome: job.state, explanation: job.reason, job_id: job.id, state: job.state }
  }

  /** Import advisory packets already delivered on the card, including expired
   * webhook attempts. Publication still uses the normal schema and evidence
   * validator; this does not answer, claim, dispatch, or change the source. */
  async importComments(cardId: string, blocks: CardContextRead['blocks']) {
    const evidence = this.evidence(cardId)
    if (evidence.reasons.length) return
    const comments = newestCommentPackets(blocks, evidence)
    if (!comments.length) return
    await this.initialize()
    const imported = await this.packets.leases.writeStorage(db => comments.flatMap(comment => {
      if (comment.job_id && db.prepare("SELECT 1 FROM decision_prep_jobs WHERE id = ? AND state = 'superseded'").get(comment.job_id)) return []
      const operation = createHash('sha256').update(JSON.stringify([cardId, comment.comment_id])).digest('hex')
      const previous = db.prepare("SELECT packet_id AS id FROM decision_packet_events WHERE type = 'comment-import' AND json_extract(detail,'$.card_id') = ? AND json_extract(detail,'$.comment_id') = ? ORDER BY sequence DESC LIMIT 1").get(cardId, comment.comment_id) as { id: string } | undefined
      let packet = comment.packet, publication = operation
      const prior = previous && this.packets.readInStorage(db, previous.id, evidence)
      if (prior) {
        // Correct only the two mapper defects in an existing current import.
        // Retain its original binding/dependencies; an older comment must not
        // replace newer preparation or borrow a changed source revision.
        if (prior.reasons.includes('Packet is superseded') || bindingMeaning(prior.packet.binding) !== bindingMeaning(packet.binding)) return [{ id: prior.id, comment }]
        const questionChanged = prior.packet.question !== packet.question
        const reversibilityMissing = prior.packet.material_unknowns.some(reason => /^Missing required field: reversibility(?:\.|$)/.test(reason))
        const reversibilityRecovered = reversibilityMissing && !packet.material_unknowns.some(reason => /^Missing required field: reversibility(?:\.|$)/.test(reason))
        if (!questionChanged && !reversibilityRecovered) return [{ id: prior.id, comment }]
        packet = { ...prior.packet, question: packet.question,
          ...(questionChanged ? { background: packet.background } : {}),
          ...(reversibilityRecovered ? { reversibility: packet.reversibility, material_unknowns: prior.packet.material_unknowns.filter(reason => !/^Missing required field: reversibility(?:\.|$)/.test(reason)) } : {}) }
        publication = createHash('sha256').update(JSON.stringify([operation, 'mapping-correction', packetContentHash(packet)])).digest('hex')
      }
      const stored = this.packets.publishInStorage(db, packet, evidence, commentPacketActor, publication)
      if (!stored.replayed) db.prepare('INSERT INTO decision_packet_events(packet_id,type,actor,at,detail) VALUES(?,?,?,?,?)').run(stored.id, 'comment-import', commentPacketActor, new Date(this.now()).toISOString(), JSON.stringify({ source: commentPacketSource, card_id: cardId, request_id: packet.binding.request_id, source_revision: packet.binding.source_revision, comment_id: comment.comment_id, job_id: comment.job_id, ...(prior ? { corrected_from: prior.id, reason: 'Use exact request question and source undo wording' } : {}) }))
      return [{ id: stored.id, comment }]
    }))
    // A restart or a later source refresh renews evidence even when publication
    // was idempotent. Validation failures never become a permanent Ready bit.
    for (const { id, comment } of imported) {
      await this.packets.validate(id, evidence, commentPacketActor)
      if (!comment.job_id) continue
      await this.packets.leases.writeStorage(db => {
        const current = this.packets.readInStorage(db, id, evidence)
        db.prepare('UPDATE decision_prep_jobs SET state = CASE WHEN published_at IS NOT NULL OR ? THEN \'published\' ELSE ? END, published_at = CASE WHEN ? THEN coalesce(published_at, ?) ELSE published_at END, reason = CASE WHEN published_at IS NOT NULL THEN reason ELSE ? END, updated_at = ?, packet_id = ? WHERE id = ? AND scope = ? AND card_id = ? AND request_id = ? AND source_revision = ? AND state != \'superseded\' AND (packet_id IS NULL OR packet_id = ? OR state IN (\'failed\',\'blocked\'))')
          .run(Number(!!current?.validation.valid), 'blocked', Number(!!current?.validation.valid), new Date(this.now()).toISOString(), current?.ready ? 'Packet imported from card comment and ready for review.' : current?.reasons.join(' ') || 'Packet is not ready.', new Date(this.now()).toISOString(), id, comment.job_id, this.scope, cardId, comment.packet.binding.request_id, comment.packet.binding.source_revision, id)
      })
    }
  }

  /** Store a bot packet for one open job. Ready is the existing validation result, never a status or lease change. */
  async publish(input: unknown) {
    const parsed = z.object({ job_id: z.string().uuid(), operation_id: z.string().trim().min(1).max(128), packet: decisionPacketSchema }).strict().parse(input)
    await this.initialize()
    await this.packets.leases.writeStorage(db => this.expire(db))
    return this.packets.leases.writeStorage(db => {
      const job = db.prepare('SELECT * FROM decision_prep_jobs WHERE id = ? AND scope = ?').get(parsed.job_id, this.scope) as Row | undefined
      if (!job) throw new DecisionDeskConflict('Preparation job is unavailable')
      if (parsed.packet.binding.card_id !== job.card_id || parsed.packet.binding.request_id !== job.request_id || parsed.packet.binding.source_revision !== job.source_revision) throw new DecisionDeskConflict('Packet does not match this preparation job')
      if (job.state === 'superseded') throw new DecisionDeskConflict('This preparation attempt has been replaced')
      const evidence = this.evidence(job.card_id)
      if (job.state === 'published' && job.packet_id) {
        const current = this.packets.readInStorage(db, job.packet_id, evidence)
        return { outcome: current?.ready ? 'ready' : 'not-ready', job_id: job.id, packet_id: job.packet_id, ready: !!current?.ready, reasons: current?.reasons ?? [], replayed: true }
      }
      if (!['admitted', 'dispatched', 'blocked', 'failed'].includes(job.state)) throw new DecisionDeskConflict('This preparation attempt is not open for publication')
      const stored = this.packets.publishInStorage(db, parsed.packet, evidence, preparerName, parsed.operation_id)
      const current = this.packets.readInStorage(db, stored.id, evidence)
      const ready = !!current?.ready
      const reasons = current?.reasons ?? stored.validation?.reasons ?? []
      db.prepare('UPDATE decision_prep_jobs SET state = CASE WHEN published_at IS NOT NULL OR ? THEN \'published\' ELSE ? END, published_at = CASE WHEN ? THEN coalesce(published_at, ?) ELSE published_at END, reason = CASE WHEN published_at IS NOT NULL THEN reason ELSE ? END, updated_at = ?, packet_id = ? WHERE id = ?')
        .run(Number(!!current?.validation.valid), 'blocked', Number(!!current?.validation.valid), new Date(this.now()).toISOString(), ready ? 'Packet is ready for review.' : reasons.join(' ') || 'Packet is not ready.', new Date(this.now()).toISOString(), stored.id, job.id)
      return { outcome: ready ? 'ready' : 'not-ready', job_id: job.id, packet_id: stored.id, ready, reasons, replayed: stored.replayed }
    })
  }
}

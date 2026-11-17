import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { decisionPacketSchema, type DecisionEvidence } from '../../shared/decisionPacket'
import { DecisionDeskConflict, type DecisionPackets } from './decisionPackets'
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
  state: string; reason: string; actor: string; mode: string; attempt: number; packet_id: string | null
}
export interface PreparationReport {
  configured: boolean; preparer: string; explanation: string; preparing: number
  automatic_replenishment: boolean
  jobs: PreparationJob[]
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
  constructor(readonly packets: DecisionPackets, readonly scope: string, private source: { candidates(cardId?: string): PrepCandidate[] | Promise<PrepCandidate[]>; coverage(): 'complete' | 'unknown' },
    private evidence: (cardId: string) => DecisionEvidence, private readSecret: (name: string) => Promise<string | null> = readClavisValue,
    private now = Date.now, private fetchImpl: typeof fetch = fetch) {}

  private initialize() {
    return this.initialized ??= this.packets.initialize().then(() => this.packets.leases.writeStorage(db => db.exec(`
      CREATE TABLE IF NOT EXISTS decision_prep_jobs (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, card_id TEXT NOT NULL, request_id TEXT NOT NULL,
        source_revision TEXT NOT NULL, card_url TEXT NOT NULL, state TEXT NOT NULL, reason TEXT NOT NULL,
        actor TEXT NOT NULL, mode TEXT NOT NULL, operation_id TEXT NOT NULL, attempt INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, dispatched_at TEXT, packet_id TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS decision_prep_active
        ON decision_prep_jobs(scope, card_id, request_id, source_revision)
        WHERE state IN ('admitted', 'dispatched');`)))
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
    db.prepare("UPDATE decision_prep_jobs SET state = 'failed', reason = ?, updated_at = ? WHERE scope = ? AND state IN ('admitted','dispatched','blocked') AND coalesce(dispatched_at, created_at) < ?")
      .run('Preparer did not publish before the attempt expired.', new Date(this.now()).toISOString(), this.scope, cutoff)
  }

  private held(db: DatabaseSync, card: string) {
    return this.packets.leases.activeInStorage(this.packets.leases.rowInStorage(db, card)) || this.packets.leases.reservedInStorage(db, card)
  }

  private refusal(candidate: PrepCandidate): string | null {
    if (candidate.answered) return 'This source request already has an answer.'
    if (candidate.leased) return 'A reviewer holds this card. Preparation does not claim or replace that lease.'
    if (candidate.card_status === 'Todo') return 'Todo work is not prepared to fill the queue.'
    if (!candidate.request_id || !candidate.source_revision) return 'This decision has no exact source request to prepare.'
    if (candidate.reasons.length) return candidate.reasons[0]!
    return null
  }

  /** Admit at most one job for this revision. Network I/O stays outside this transaction. */
  private admit(db: DatabaseSync, candidate: PrepCandidate, mode: 'automatic' | 'prepare-now', actor: string, reason: string): PrepareResult & { job?: Row } {
    this.expire(db)
    const blocked = this.refusal(candidate)
    if (blocked) return { outcome: 'ineligible', explanation: blocked }
    if (this.held(db, candidate.card_id)) return { outcome: 'ineligible', explanation: 'A reviewer holds this card. Preparation does not claim or replace that lease.' }
    if (this.readyRevision(db, candidate)) return { outcome: 'already-ready', explanation: 'This decision revision is already ready for review.' }
    const active = db.prepare("SELECT * FROM decision_prep_jobs WHERE scope = ? AND card_id = ? AND request_id = ? AND source_revision = ? AND state IN ('admitted','dispatched')").get(this.scope, candidate.card_id, candidate.request_id, candidate.source_revision) as Row | undefined
    if (active) return { outcome: 'already-preparing', explanation: 'This decision revision is already being prepared.', job_id: active.id, state: active.state, job: active }
    const policy = this.packets.policyInStorage(db, this.scope)
    const inflight = this.inflight(db)
    if (inflight >= policy.values.max_preparers) return { outcome: 'at-capacity', explanation: 'All preparer slots are in use. Wait for a job to finish or raise the maximum parallel preparers.' }
    if (mode === 'automatic' && (policy.values.automatic_replenishment !== true || this.readyCount(db) + inflight >= policy.values.target_ready)) return { outcome: 'depth-met', explanation: 'Ready decisions and in-flight jobs already fill the target depth.' }
    const id = randomUUID(), at = new Date(this.now()).toISOString()
    const prior = Number((db.prepare('SELECT count(*) AS n FROM decision_prep_jobs WHERE scope = ? AND card_id = ? AND request_id = ? AND source_revision = ?').get(this.scope, candidate.card_id, candidate.request_id, candidate.source_revision) as { n: number }).n)
    db.prepare("UPDATE decision_prep_jobs SET state = 'cancelled', reason = ?, updated_at = ? WHERE scope = ? AND card_id = ? AND request_id = ? AND source_revision = ? AND state = 'blocked'")
      .run('Superseded by a new preparation attempt.', at, this.scope, candidate.card_id, candidate.request_id, candidate.source_revision)
    const job: Row = { id, scope: this.scope, card_id: candidate.card_id, request_id: candidate.request_id, source_revision: candidate.source_revision, card_url: candidate.card_url,
      state: 'admitted', reason: 'Admitted for preparation.', actor, mode, attempt: prior + 1, packet_id: null, created_at: at, updated_at: at, dispatched_at: null }
    db.prepare('INSERT INTO decision_prep_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, this.scope, candidate.card_id, candidate.request_id, candidate.source_revision, candidate.card_url, 'admitted', job.reason, actor, mode, `prep-${id}`, job.attempt, at, at, null, null)
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
    if (this.secret && problem) explanation += ` Latest problem: ${problem.reason}`
    return { configured: !!this.secret, preparer: preparerName, explanation, preparing, automatic_replenishment: policy.values.automatic_replenishment,
      jobs: jobs.map(({ id, card_id, request_id, source_revision, card_url, state, reason, actor, mode, attempt, packet_id }) => ({ id, card_id, request_id, source_revision, card_url, state, reason, actor, mode, attempt, packet_id })) }
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
    try {
      await this.ensureConfig()
      await this.initialize()
      const policy = await this.packets.readPolicy(this.scope)
      this.automatic = policy.values.automatic_replenishment
      // Collect outside the lease transaction. Nested SQLite opens deadlock the writer.
      await this.packets.leases.writeStorage(db => this.expire(db))
      if (!this.secret || !policy.values.automatic_replenishment || this.source.coverage() !== 'complete') return
      const admitted: Row[] = []
      const candidates = await this.source.candidates()
      for (const candidate of [...candidates].sort((a, b) => a.rank - b.rank)) {
        const result = await this.packets.leases.writeStorage(db => this.admit(db, candidate, 'automatic', 'decision-desk', 'Automatic replenishment'))
        if (result.outcome === 'depth-met' || result.outcome === 'at-capacity') break
        if (result.job && result.outcome === 'admitted') admitted.push(result.job)
      }
      for (const job of admitted) await this.dispatch(job)
    } catch { /* A preparation pass must not take down the server. The next pass retries. */ }
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
    await this.packets.leases.writeStorage(db => {
      for (const comment of comments) {
        const operation = createHash('sha256').update(JSON.stringify([cardId, comment.comment_id])).digest('hex')
        const previous = db.prepare('SELECT id FROM decision_packets WHERE publication_key = ?').get(JSON.stringify([commentPacketActor, operation])) as { id: string } | undefined
        // A comment is imported once. Re-reading history may re-attest the same
        // revision, but must never bind an old comment to a changed request.
        if (previous) continue
        const stored = this.packets.publishInStorage(db, comment.packet, evidence, commentPacketActor, operation)
        db.prepare('INSERT INTO decision_packet_events(packet_id,type,actor,at,detail) VALUES(?,?,?,?,?)').run(stored.id, 'comment-import', commentPacketActor, new Date(this.now()).toISOString(), JSON.stringify({ source: commentPacketSource, card_id: cardId, request_id: comment.packet.binding.request_id, source_revision: comment.packet.binding.source_revision, comment_id: comment.comment_id, job_id: comment.job_id }))
        if (comment.job_id) {
          const current = this.packets.readInStorage(db, stored.id, evidence)
          db.prepare('UPDATE decision_prep_jobs SET state = ?, reason = ?, updated_at = ?, packet_id = ? WHERE id = ? AND scope = ? AND card_id = ? AND request_id = ? AND source_revision = ?')
            .run(current?.ready ? 'published' : 'blocked', current?.ready ? 'Packet imported from card comment and ready for review.' : current?.reasons.join(' ') || 'Packet is not ready.', new Date(this.now()).toISOString(), stored.id, comment.job_id, this.scope, cardId, comment.packet.binding.request_id, comment.packet.binding.source_revision)
        }
      }
    })
    // Fresh, complete history can renew evidence for an unchanged comment, but
    // cannot extend the immutable packet's review freshness or change its body.
    for (const comment of comments) {
      const operation = createHash('sha256').update(JSON.stringify([cardId, comment.comment_id])).digest('hex')
      const previous = this.packets.leases.readStorage(db => db.prepare('SELECT id FROM decision_packets WHERE publication_key = ?').get(JSON.stringify([commentPacketActor, operation]))) as { id: string } | undefined
      if (previous) await this.packets.validate(previous.id, evidence, commentPacketActor)
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
      const evidence = this.evidence(job.card_id)
      if (job.state === 'published' && job.packet_id) {
        const current = this.packets.readInStorage(db, job.packet_id, evidence)
        return { outcome: current?.ready ? 'ready' : 'not-ready', job_id: job.id, packet_id: job.packet_id, ready: !!current?.ready, reasons: current?.reasons ?? [], replayed: true }
      }
      const started = Date.parse(job.dispatched_at ?? job.created_at)
      if (Number.isFinite(started) && started + attemptMs < this.now()) throw new DecisionDeskConflict('This preparation attempt expired before publication')
      if (!['admitted', 'dispatched', 'blocked'].includes(job.state)) throw new DecisionDeskConflict('This preparation attempt is not open for publication')
      const stored = this.packets.publishInStorage(db, parsed.packet, evidence, preparerName, parsed.operation_id)
      const current = this.packets.readInStorage(db, stored.id, evidence)
      const ready = !!current?.ready
      const reasons = current?.reasons ?? stored.validation?.reasons ?? []
      db.prepare('UPDATE decision_prep_jobs SET state = ?, reason = ?, updated_at = ?, packet_id = ? WHERE id = ?')
        .run(ready ? 'published' : 'blocked', ready ? 'Packet is ready for review.' : reasons.join(' ') || 'Packet is not ready.', new Date(this.now()).toISOString(), stored.id, job.id)
      return { outcome: ready ? 'ready' : 'not-ready', job_id: job.id, packet_id: stored.id, ready, reasons, replayed: stored.replayed }
    })
  }
}

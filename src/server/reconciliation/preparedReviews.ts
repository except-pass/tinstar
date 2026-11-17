import { commentPacketActor } from './commentPacket'
import { workReadback } from './workReadback'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { cardIdSchema } from '../../shared/workIdentity'
import type { DecisionEvidence, DecisionPacketBinding } from '../../shared/decisionPacket'
import { CardLeaseError, leaseHash, publicLease, SourceWritePending, type CardLease } from './cardLeases'
import { DecisionDeskConflict, DecisionPackets } from './decisionPackets'
import type { PreparationReport } from './decisionPrep'

export const reviewSessionInput = z.object({ operation_id: z.string().min(1).max(128), label: z.string().trim().min(1).max(100), device: z.enum(['phone', 'desktop', 'other']).default('other') }).strict()
export const preparedClaimInput = z.object({ operation_id: z.string().min(1).max(128), review_session_token: z.string().min(1).max(256).optional(), lease_token: z.string().min(1).max(256).optional(), card_id: cardIdSchema.optional() }).strict()
export const preparedReleaseInput = z.object({ ...preparedClaimInput.omit({ card_id: true }).shape, reason: z.string().trim().min(1).max(1000).default('No reason supplied'), action: z.enum(['release', 'skip', 'research']).default('release') }).strict()
type ClaimInput = z.infer<typeof preparedClaimInput>
interface Session { id: string; caller: string; scope: string; label: string; device: string; token_hash: string; operation: string; signature: string; created: number; expires: number; revoked: number | null }
export interface PreparedBinding { session_id: string; card: string; generation: number; packet_id: string; packet_version: number; token_hash: string; claim_operation: string }
export interface PreparedQueue { card_ids: string[]; coverage: 'complete' | 'unknown'; requests: number | null
  history?: Array<{ card_id: string; title: string; state: 'loading' | 'available' | 'unavailable'; observed_at: string | null; expires_at: string | null; message?: string | null; retry_at?: string | null }> }
export interface PreparedClaimResult { outcome: string; lease?: CardLease; lease_token?: string; packet?: ReturnType<DecisionPackets['readInStorage']>; session_id?: string; packet_version?: number; message?: string; coverage?: string }
const sessionLifetime = 24 * 60 * 60 * 1000

/** Explicit contexts, not inferred conversations. Packet validation, canonical
 * lease allocation and held version binding commit in the same transaction. */
const unconfiguredPreparation = (): PreparationReport => ({
  configured: false, preparer: 'Tinstar Decision Prep', explanation: 'The preparer webhook is not configured.',
  preparing: 0, automatic_replenishment: false, jobs: [],
})

export class PreparedReviews {
  private initialized?: Promise<void>
  reportPreparation: () => Promise<PreparationReport> | PreparationReport = unconfiguredPreparation
  refreshEvidence: () => void | Promise<void> = () => {}
  constructor(readonly packets: DecisionPackets, readonly scope: string, private evidence: (card: string) => DecisionEvidence,
    private queue: () => PreparedQueue, private now = Date.now) {}
  private get leases() { return this.packets.leases }
  async initialize() {
    await this.packets.initialize()
    return this.initialized ??= this.leases.writeStorage(db => db.exec(`
      CREATE TABLE IF NOT EXISTS decision_review_sessions (
        id TEXT PRIMARY KEY, caller TEXT NOT NULL, scope TEXT NOT NULL, label TEXT NOT NULL, device TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, operation TEXT NOT NULL, signature TEXT NOT NULL, created INTEGER NOT NULL,
        expires INTEGER NOT NULL, revoked INTEGER, UNIQUE(caller,scope,operation));
      CREATE TABLE IF NOT EXISTS decision_review_bindings (
        session_id TEXT PRIMARY KEY, card TEXT NOT NULL, generation INTEGER NOT NULL, packet_id TEXT NOT NULL,
        packet_version INTEGER NOT NULL, token_hash TEXT NOT NULL, claim_operation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decision_review_operations (
        caller TEXT NOT NULL, scope TEXT NOT NULL, operation TEXT NOT NULL, signature TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(caller,scope,operation));`))
  }
  private open(db: DatabaseSync, caller: string, input: z.infer<typeof reviewSessionInput>, implicit = false) {
    const operation = JSON.stringify([implicit ? 'initial-claim' : 'explicit-open', input.operation_id])
    const signature = JSON.stringify([input.label, input.device])
    const previous = db.prepare('SELECT * FROM decision_review_sessions WHERE caller = ? AND scope = ? AND operation = ?').get(caller, this.scope, operation) as unknown as Session | undefined
    const token = this.leases.capability(caller, JSON.stringify(['review-session', this.scope, operation]))
    if (previous) {
      if (previous.signature !== signature) throw new DecisionDeskConflict('Session operation already used with different input')
      if (previous.revoked || previous.expires <= this.now()) throw new DecisionDeskConflict('Review session expired or closed; explicitly create a new session')
      return { session: previous, token }
    }
    const session: Session = { id: randomUUID(), caller, scope: this.scope, label: input.label, device: input.device, token_hash: leaseHash(token), operation,
      signature, created: this.now(), expires: this.now() + sessionLifetime, revoked: null }
    db.prepare('INSERT INTO decision_review_sessions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(session.id, caller, this.scope, session.label, session.device, session.token_hash, session.operation, signature, session.created, session.expires, null)
    return { session, token }
  }
  async create(caller: string, input: unknown) {
    const parsed = reviewSessionInput.parse(input)
    await this.initialize()
    return this.leases.writeStorage(db => {
      const { session, token } = this.open(db, caller, parsed)
      return { session: this.summary(db, session), review_session_token: token }
    })
  }
  private summary(db: DatabaseSync, session: Session) {
    const binding = db.prepare('SELECT * FROM decision_review_bindings WHERE session_id = ?').get(session.id) as unknown as PreparedBinding | undefined
    const row = binding ? this.leases.rowInStorage(db, binding.card) : undefined
    const held = this.leases.activeInStorage(row) && row.generation === binding?.generation && row.caller === session.caller
    const packet = held ? db.prepare('SELECT body FROM decision_packets WHERE id = ?').get(binding!.packet_id) as { body: string } | undefined : undefined
    return { id: session.id, label: workReadback(session.label), device: session.device, created_at: new Date(session.created).toISOString(), expires_at: new Date(session.expires).toISOString(),
      held: held ? { lease: publicLease(row), packet_id: binding!.packet_id, packet_version: binding!.packet_version, title: packet ? workReadback(JSON.parse(packet.body).title as string) : null } : null }
  }
  async list(caller: string) {
    await this.initialize()
    return this.leases.readStorage(db => ({ sessions: (db.prepare('SELECT * FROM decision_review_sessions WHERE caller = ? AND scope = ? AND revoked IS NULL AND expires > ? ORDER BY created,id').all(caller, this.scope, this.now()) as unknown as Session[]).map(session => this.summary(db, session)) }))
  }
  /** Project known evidence, scheduling history outside the storage transaction. */
  async snapshot() {
    await this.initialize()
    await this.refreshEvidence()
    const prep = await this.reportPreparation()
    return this.leases.readStorage(db => {
      const queue = this.queue(), now = this.now()
      const evidenceByCard = new Map(queue.card_ids.map(card => [card, this.evidence(card)]))
      const sourceFailures = [...evidenceByCard].flatMap(([card_id, evidence]) => {
        const reasons = [...evidence.reasons, ...evidence.requests.flatMap(request => request.reasons)]
        return reasons.length ? [{ card_id, reasons: [...new Set(reasons)] }] : []
      })
      const answers = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'decision_desk_confirmed_answers'").get()
        ? db.prepare('SELECT 1 FROM decision_desk_confirmed_answers WHERE scope = ? AND card = ? AND request_id = ? AND source_revision = ?') : null
      const recorded = (binding: DecisionPacketBinding) => !!answers?.get(this.scope, binding.card_id, binding.request_id, binding.source_revision)
      const rows = db.prepare(`SELECT id FROM decision_packets p WHERE version =
        (SELECT max(version) FROM decision_packets WHERE source_key = p.source_key)`).all() as Array<{ id: string }>
      const current = rows.map(row => {
        const stored = this.packets.readInStorage(db, row.id)!
        return this.packets.readInStorage(db, row.id, evidenceByCard.get(stored.packet.binding.card_id) ?? this.evidence(stored.packet.binding.card_id))!
      }).filter(stored => queue.card_ids.includes(stored.packet.binding.card_id) && !recorded(stored.packet.binding))
      const needsResearch = (packet: (typeof current)[number]) => !packet.validation.valid || !packet.validation.valid_until || Date.parse(packet.validation.valid_until) <= now
      const held = new Set(queue.card_ids.filter(card => this.leases.activeInStorage(this.leases.rowInStorage(db, card))))
      const ready = current.filter(stored => stored.ready)
      const pending = queue.card_ids.flatMap(card => {
        const evidence = evidenceByCard.get(card)!
        return evidence.requests.filter(request => !request.answered && (!request.binding || !recorded(request.binding))).map(request => {
          const packet = current.find(stored => stored.packet.binding.card_id === card && stored.packet.binding.request_id === request.binding?.request_id)
          return { card_id: card, request_id: request.binding?.request_id ?? null, source_revision: request.binding?.source_revision ?? null,
            title: packet?.packet.title ?? request.question ?? 'Source request needs verification',
            state: packet?.ready ? 'Ready' : held.has(card) ? packet && needsResearch(packet) ? 'Blocked' : 'Leased' : packet?.prepared_by === commentPacketActor ? 'Blocked' : request.binding && !request.reasons.length && !evidence.reasons.length ? 'Queued' : 'Blocked',
            reasons: [...evidence.reasons, ...request.reasons, ...(packet && !packet.ready && !held.has(card) ? packet.reasons : [])] }
        })
      })
      for (const row of pending) {
        if (row.state !== 'Queued' || held.has(row.card_id)) continue
        const job = prep.jobs.find(job => job.card_id === row.card_id && job.request_id === row.request_id && job.source_revision === row.source_revision)
        if (!job || !['admitted', 'dispatched', 'failed', 'blocked'].includes(job.state)) continue
        row.state = job.state === 'admitted' || job.state === 'dispatched' ? 'Working' : job.state === 'blocked' ? 'Blocked' : 'Failed'
        if (job.reason) row.reasons = [...new Set([...row.reasons, job.reason])]
      }
      const verified = queue.coverage === 'complete' && !sourceFailures.length
      return { scope: this.scope, observed_at: new Date(now).toISOString(), coverage: verified ? 'complete' : 'unknown',
        counts: { ready: verified ? new Set(ready.map(packet => packet.packet.binding.card_id)).size : null,
          leased: verified ? held.size : null, preparing: prep.preparing,
          needs_repreparation: verified ? current.filter(packet => !this.packets.pendingAnswerInStorage(db, packet.id) && needsResearch(packet)).length : null,
          to_prepare: verified && queue.requests !== null ? pending.filter(row => row.state === 'Queued').length : null,
          requests: verified ? queue.requests : null },
        runner: { configured: prep.configured, preparer: prep.preparer, explanation: prep.explanation, refill_pass: prep.refill_pass, jobs: prep.jobs },
        ready: ready.map(packet => ({ id: packet.id, card_id: packet.packet.binding.card_id, request_id: packet.packet.binding.request_id, title: packet.packet.title, risk: packet.packet.risk.rating })),
        recorded_requests: db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'decision_desk_confirmed_answers'").get()
          ? (db.prepare('SELECT card,request_id,confirmed FROM decision_desk_confirmed_answers WHERE scope = ? ORDER BY confirmed DESC LIMIT 100').all(this.scope) as Array<{ card: string; request_id: string; confirmed: number }>).map(row => ({ card_id: row.card, request_id: row.request_id, confirmed_at: new Date(row.confirmed).toISOString() })) : [],
        pending, history: queue.history ?? [], source_failures: sourceFailures, omissions: verified ? [] : ['Source coverage is incomplete or unavailable; queue totals cannot be verified.'] }
    })
  }
  private session(db: DatabaseSync, caller: string, input: Pick<ClaimInput, 'review_session_token' | 'lease_token'>): Session | undefined {
    let session: Session | undefined
    if (input.review_session_token) session = db.prepare('SELECT * FROM decision_review_sessions WHERE token_hash = ? AND caller = ? AND scope = ?').get(leaseHash(input.review_session_token), caller, this.scope) as unknown as Session | undefined
    else if (input.lease_token) session = db.prepare('SELECT s.* FROM decision_review_sessions s JOIN decision_review_bindings b ON b.session_id = s.id WHERE b.token_hash = ? AND s.caller = ? AND s.scope = ?').get(leaseHash(input.lease_token), caller, this.scope) as unknown as Session | undefined
    else return undefined
    if (!session || session.revoked || session.expires <= this.now()) throw new CardLeaseError(null)
    return session
  }
  private held(db: DatabaseSync, session: Session, leaseToken?: string) {
    const binding = db.prepare('SELECT * FROM decision_review_bindings WHERE session_id = ?').get(session.id) as unknown as PreparedBinding | undefined
    if (!binding) { if (leaseToken) throw new CardLeaseError(null); return null }
    const row = this.leases.rowInStorage(db, binding.card)
    const current = this.leases.activeInStorage(row) && row.caller === session.caller && row.generation === binding.generation && row.token_hash === binding.token_hash
    if (leaseToken && (!current || leaseHash(leaseToken) !== binding.token_hash)) throw new CardLeaseError(null)
    if (!current) { if (this.leases.reviewReservedInStorage(db, binding.card)) throw new SourceWritePending(); return null }
    const token = this.leases.capability(session.caller, binding.claim_operation)
    const stored = this.packets.readInStorage(db, binding.packet_id, this.evidence(binding.card))
    // Ready normally excludes leases; held validation instead ignores only this
    // context's canonical lease, never source freshness or a pending workflow write.
    const blocked = !stored?.validation.valid || !stored.validation.valid_until || Date.parse(stored.validation.valid_until) <= this.now() || this.leases.reviewReservedInStorage(db, binding.card)
    return { outcome: blocked ? 'packet-invalidated' : 'held', lease: publicLease(row), lease_token: token, packet: stored ? {
      ...workReadback(stored), packet: {
        ...workReadback(stored.packet), recommended_option_id: stored.packet.recommended_option_id,
        binding: {
          ...workReadback(stored.packet.binding), card_id: stored.packet.binding.card_id,
          request_key: stored.packet.binding.request_key, source_request: stored.packet.binding.source_request,
          request_id: stored.packet.binding.request_id, source_id: stored.packet.binding.source_id,
          source_spawn_gen: stored.packet.binding.source_spawn_gen,
          options: stored.packet.binding.options.map(option => ({ id: option.id, label: workReadback(option.label) })),
        },
      },
    } : null, session_id: session.id, packet_version: binding.packet_version }
  }
  private receipt(db: DatabaseSync, caller: string, operation: string, signature: string) {
    const previous = db.prepare('SELECT signature,result FROM decision_review_operations WHERE caller = ? AND scope = ? AND operation = ?').get(caller, this.scope, operation) as { signature: string; result: string } | undefined
    if (previous && previous.signature !== signature) throw new DecisionDeskConflict('Review operation already used with different input')
    return previous ? JSON.parse(previous.result) as { session_id?: string; outcome: string; claim_operation?: string; card_id?: string; next_operation_id?: string | null } : null
  }
  private record(db: DatabaseSync, caller: string, operation: string, signature: string, result: unknown) {
    db.prepare('INSERT INTO decision_review_operations VALUES(?,?,?,?,?)').run(caller, this.scope, operation, signature, JSON.stringify(result))
  }
  async claim(caller: string, holder: string, input: unknown): Promise<PreparedClaimResult> {
    const started = performance.now()
    const parsed = preparedClaimInput.parse(input)
    await this.initialize()
    const operationKey = leaseHash(JSON.stringify([caller, this.scope, parsed.operation_id]))
    try {
      return await this.leases.writeStorage(db => {
        const result = this.claimInStorage(db, caller, holder, parsed)
        this.leases.auditInStorage(db, result.lease?.card_id ?? '', 'prepared-claim', { operation_key: operationKey, outcome: result.outcome, duration_ms: performance.now() - started, session_id: result.session_id ?? null })
        return result
      })
    } catch (error) {
      if (error instanceof CardLeaseError) await this.leases.writeStorage(db => this.leases.auditInStorage(db, parsed.card_id ?? '', 'prepared-claim-conflict', { operation_key: operationKey, outcome: error instanceof SourceWritePending ? 'source-write-pending' : error.lease ? 'card-held' : 'claim-lost', duration_ms: performance.now() - started }))
      throw error
    }
  }
  claimInStorage(db: DatabaseSync, caller: string, holder: string, input: ClaimInput, excludeCard?: string): PreparedClaimResult {
    const signature = JSON.stringify(['claim', input.card_id ?? null, input.review_session_token ? leaseHash(input.review_session_token) : null, input.lease_token ? leaseHash(input.lease_token) : null, excludeCard ?? null])
    const previous = this.receipt(db, caller, input.operation_id, signature)
    let session = this.session(db, caller, input)
    if (previous) {
      if (!previous.session_id) return previous
      const previousSession = db.prepare('SELECT * FROM decision_review_sessions WHERE id = ? AND caller = ? AND scope = ?').get(previous.session_id, caller, this.scope) as unknown as Session | undefined
      if (!previousSession || previousSession.revoked || previousSession.expires <= this.now()) throw new CardLeaseError(null)
      // The same operation must not return a later card in this context.
      const binding = db.prepare('SELECT claim_operation FROM decision_review_bindings WHERE session_id = ?').get(previousSession.id) as { claim_operation: string } | undefined
      if (binding?.claim_operation !== previous.claim_operation) throw new CardLeaseError(null)
      const resumed = this.held(db, previousSession, input.lease_token)
      if (!resumed) throw new CardLeaseError(null)
      return { ...resumed, outcome: resumed.outcome === 'held' ? previous.outcome : resumed.outcome }
    }
    if (session) {
      const held = this.held(db, session, input.lease_token)
      if (held) {
        const binding = db.prepare('SELECT claim_operation FROM decision_review_bindings WHERE session_id = ?').get(session.id) as { claim_operation: string }
        const result = input.card_id && held.lease.card_id !== input.card_id ? { ...held, outcome: 'already-holding' } : held
        this.record(db, caller, input.operation_id, signature, { outcome: result.outcome, session_id: session.id, claim_operation: binding.claim_operation })
        return result
      }
    }
    const queue = this.queue()
    const cards = input.card_id ? [input.card_id] : queue.card_ids
    let invalid = false
    for (const card of cards) {
      if (card === excludeCard) continue
      const lease = this.leases.rowInStorage(db, card)
      if (this.leases.activeInStorage(lease)) { if (input.card_id) throw new CardLeaseError(publicLease(lease)); continue }
      if (this.leases.reviewReservedInStorage(db, card)) continue
      const rows = db.prepare('SELECT id FROM decision_packets WHERE json_extract(body,\'$.binding.card_id\') = ? ORDER BY source_key,version DESC').all(card) as Array<{ id: string }>
      for (const row of rows) {
        // Recheck both current source meaning and the latest durable invalidation
        // under the same writer transaction as the canonical lease allocation.
        const packet = this.packets.readInStorage(db, row.id, this.evidence(card))
        if (!packet?.ready) {
          invalid = true
          this.leases.auditInStorage(db, card, 'prepared-claim-blocked', { packet_id: row.id, reasons: packet?.reasons ?? ['Packet unavailable'] })
          continue
        }
        session ??= this.open(db, caller, { operation_id: input.operation_id, label: holder, device: 'other' }, true).session
        const claimOperation = JSON.stringify(['prepared-claim', this.scope, input.operation_id])
        const claim = this.leases.claimInStorage(db, [card], caller, holder, claimOperation, undefined, true)
        if (!('lease' in claim) || !claim.lease || !('lease_token' in claim) || !claim.lease_token) throw new Error('Canonical lease allocation failed')
        db.prepare('INSERT OR REPLACE INTO decision_review_bindings VALUES(?,?,?,?,?,?,?)').run(session.id, card, claim.lease.generation, packet.id, packet.version, leaseHash(claim.lease_token), claimOperation)
        const response = { ...this.held(db, session)!, outcome: 'claimed' }
        this.record(db, caller, input.operation_id, signature, { outcome: 'claimed', session_id: session.id, claim_operation: claimOperation })
        this.leases.auditInStorage(db, card, 'prepared-claimed', { session_id: session.id, packet_id: packet.id, packet_version: packet.version, generation: claim.lease.generation })
        return response
      }
    }
    const result = { outcome: queue.coverage === 'unknown' ? 'source-unavailable' : queue.requests === 0 ? 'no-decision-requests' : invalid ? 'no-ready-packet' : 'no-prepared-decisions', message: 'No validated, unleased prepared decision is available in the covered source scope', coverage: queue.coverage }
    this.record(db, caller, input.operation_id, signature, result)
    return result
  }
  contextInStorage(db: DatabaseSync, caller: string, input: Pick<ClaimInput, 'review_session_token' | 'lease_token'>) {
    const session = this.session(db, caller, input)
    if (!session) throw new CardLeaseError(null)
    return session.id
  }
  /** Internal submit authority: require the exact active canonical generation,
   * without treating a same-operation source reservation as a lost review. */
  submissionInStorage(db: DatabaseSync, caller: string, input: Pick<ClaimInput, 'review_session_token' | 'lease_token'>) {
    const session = this.session(db, caller, input)
    if (!session || !input.lease_token) throw new CardLeaseError(null)
    const binding = db.prepare('SELECT * FROM decision_review_bindings WHERE session_id = ?').get(session.id) as unknown as PreparedBinding | undefined
    const row = binding ? this.leases.rowInStorage(db, binding.card) : undefined
    if (!binding || !this.leases.activeInStorage(row) || row.caller !== caller || row.generation !== binding.generation || row.token_hash !== binding.token_hash || leaseHash(input.lease_token) !== binding.token_hash) throw new CardLeaseError(null)
    return { session_id: session.id, binding, lease: publicLease(row) }
  }
  claimScopeInStorage(db: DatabaseSync, caller: string, binding: PreparedBinding) {
    // The original claim receipt already records whether the selection was
    // restricted to a card. It survives releasing the binding and restarting.
    const [, , operation] = JSON.parse(binding.claim_operation)
    const receipt = db.prepare('SELECT signature FROM decision_review_operations WHERE caller = ? AND scope = ? AND operation = ?')
      .get(caller, this.scope, operation) as { signature: string } | undefined
    if (receipt && JSON.parse(receipt.signature)[1] === binding.card) return binding.card
  }
  continueInStorage(db: DatabaseSync, caller: string, holder: string, sessionId: string, operation: string, excludeCard?: string, cardId?: string) {
    const session = db.prepare('SELECT * FROM decision_review_sessions WHERE id = ? AND caller = ? AND scope = ?').get(sessionId, caller, this.scope) as unknown as Session | undefined
    if (!session || session.revoked || session.expires <= this.now()) throw new CardLeaseError(null)
    const token = this.leases.capability(caller, JSON.stringify(['review-session', this.scope, session.operation]))
    return this.claimInStorage(db, caller, holder, { operation_id: operation, review_session_token: token, card_id: cardId }, excludeCard)
  }
  tryContinueInStorage(db: DatabaseSync, caller: string, holder: string, sessionId: string, operation: string, excludeCard?: string, cardId?: string): PreparedClaimResult {
    // Next-allocation failures must not undo an already recorded release or
    // research withdrawal. Retry uses the same deterministic claim operation.
    db.exec('SAVEPOINT prepared_next')
    try {
      const result = this.continueInStorage(db, caller, holder, sessionId, operation, excludeCard, cardId)
      db.exec('RELEASE prepared_next')
      return result
    } catch {
      db.exec('ROLLBACK TO prepared_next'); db.exec('RELEASE prepared_next')
      return { outcome: 'next-unavailable' }
    }
  }
  /** After source confirmation, release only our recorded generation. A crash
   * retry must never release a later reviewer or roll back a durable answer. */
  finishInStorage(db: DatabaseSync, caller: string, binding: PreparedBinding, reason: string) {
    const row = this.leases.rowInStorage(db, binding.card)
    if (row && row.caller === caller && row.generation === binding.generation && row.token_hash === binding.token_hash) {
      if (this.leases.reservedInStorage(db, binding.card)) throw new SourceWritePending()
      this.leases.releaseInStorage(db, row, reason, caller)
    }
    db.prepare('DELETE FROM decision_review_bindings WHERE session_id = ? AND generation = ? AND packet_id = ?').run(binding.session_id, binding.generation, binding.packet_id)
  }
  async release(caller: string, holder: string, input: unknown) {
    const parsed = preparedReleaseInput.parse(input)
    await this.initialize()
    return this.leases.writeStorage(db => {
      const signature = JSON.stringify(['release', parsed.action, parsed.reason, parsed.review_session_token ? leaseHash(parsed.review_session_token) : null, parsed.lease_token ? leaseHash(parsed.lease_token) : null])
      const previous = this.receipt(db, caller, parsed.operation_id, signature)
      if (previous) {
        if (!previous.next_operation_id) return previous
        return { ...previous, next: this.tryContinueInStorage(db, caller, holder, previous.session_id!, previous.next_operation_id, previous.card_id) }
      }
      const session = this.session(db, caller, parsed)
      if (!session) throw new CardLeaseError(null)
      const held = this.held(db, session, parsed.lease_token)
      if (!held) throw new CardLeaseError(null)
      const row = this.leases.rowInStorage(db, held.lease.card_id)!
      if (this.packets.pendingAnswerInStorage(db, held.packet!.id)) throw new SourceWritePending()
      if (parsed.action === 'research') {
        if (this.leases.reservedInStorage(db, row.card)) throw new SourceWritePending()
        db.prepare('INSERT INTO decision_packet_events(packet_id,type,actor,at,detail) VALUES(?,?,?,?,?)').run(held.packet!.id, 'research-requested', caller, new Date(this.now()).toISOString(), JSON.stringify({ reason: parsed.reason }))
      }
      this.leases.releaseInStorage(db, row, parsed.reason, caller)
      db.prepare('DELETE FROM decision_review_bindings WHERE session_id = ?').run(session.id)
      const next = parsed.action !== 'release' ? this.tryContinueInStorage(db, caller, holder, session.id, `skip-next:${parsed.operation_id}`, row.card) : null
      // Tokens never enter operation storage; replay resolves the next binding.
      const result = { session_id: session.id, outcome: parsed.action === 'research' ? 'research-requested' : parsed.action === 'skip' ? 'skipped' : 'released', card_id: row.card, next_operation_id: parsed.action !== 'release' ? `skip-next:${parsed.operation_id}` : null }
      this.record(db, caller, parsed.operation_id, signature, result)
      return { ...result, next }
    })
  }
  async close(caller: string, token: string, reason: string) {
    await this.initialize()
    return this.leases.writeStorage(db => {
      const session = this.session(db, caller, { review_session_token: token })!
      const held = this.held(db, session)
      if (held) this.leases.releaseInStorage(db, this.leases.rowInStorage(db, held.lease.card_id)!, reason, caller)
      db.prepare('UPDATE decision_review_sessions SET revoked = ? WHERE id = ?').run(this.now(), session.id)
      return { outcome: 'closed' }
    })
  }
}

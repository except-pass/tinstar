import { workReadback } from './workReadback'
import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { notionCardIdSchema } from '../../shared/workIdentity'
import { CardLeaseError, leaseHash, publicLease, SourceWritePending, type CardLease } from './cardLeases'
import { DecisionDeskConflict, DecisionPackets, type StoredDecisionPacket } from './decisionPackets'
import { isLivePreparation, type DecisionPreparation } from './decisionPrep'
import type { WorkCard } from './workReader'

export const reviewSessionInput = z.object({ operation_id: z.string().min(1).max(128), label: z.string().trim().min(1).max(100), device: z.enum(['phone', 'desktop', 'other']).default('other') }).strict()
export const preparedClaimInput = z.object({ operation_id: z.string().min(1).max(128), review_session_token: z.string().min(1).max(256).optional(), lease_token: z.string().min(1).max(256).optional(), card_id: notionCardIdSchema.optional() }).strict()
export const preparedReleaseInput = z.object({ ...preparedClaimInput.omit({ card_id: true }).shape, reason: z.string().trim().min(1).max(1000).default('No reason supplied'), action: z.enum(['release', 'skip']).default('release') }).strict()
type ClaimInput = z.infer<typeof preparedClaimInput>
interface Session { id: string; caller: string; scope: string; label: string; device: string; token_hash: string; operation: string; signature: string; created: number; expires: number; revoked: number | null }
export interface PreparedBinding { session_id: string; card: string; generation: number; packet_id: string; packet_version: number; token_hash: string; claim_operation: string }
export interface PreparedQueue { cards: WorkCard[]; coverage: 'complete' | 'unknown'; revisionFor(card: WorkCard): string | undefined }
export interface PreparedClaimResult { outcome: string; lease?: CardLease; lease_token?: string; packet?: StoredDecisionPacket | null; session_id?: string; message?: string; coverage?: string }

/** Session capabilities identify the conversation. The card lease and the
 * packet selected for that lease are allocated together in one transaction. */
export class PreparedReviews {
  private initialized?: Promise<void>
  constructor(readonly packets: DecisionPackets, private queue: () => PreparedQueue,
    private readSource: (card: string) => Promise<import('./decisionEvidence').DecisionCardSource>,
    private preparation: Pick<DecisionPreparation, 'status' | 'latestJobInStorage'>, private now = Date.now) {}
  get scope() { return this.packets.scope }
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
      if (previous.revoked) throw new DecisionDeskConflict('Review session closed; open a new session')
      return { session: previous, token }
    }
    const session: Session = { id: randomUUID(), caller, scope: this.scope, label: input.label, device: input.device, token_hash: leaseHash(token), operation,
      signature, created: this.now(), expires: 0, revoked: null }
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
    const packet = held ? db.prepare('SELECT body FROM decision_card_packets WHERE id = ?').get(binding!.packet_id) as { body: string } | undefined : undefined
    return { id: session.id, label: workReadback(session.label), device: session.device, created_at: new Date(session.created).toISOString(),
      held: held ? { lease: publicLease(row), packet_id: binding!.packet_id, packet_version: binding!.packet_version, title: packet ? workReadback(JSON.parse(packet.body).title as string) : null } : null }
  }
  async list(caller: string) {
    await this.initialize()
    return this.leases.readStorage(db => ({ sessions: (db.prepare('SELECT * FROM decision_review_sessions WHERE caller = ? AND scope = ? AND revoked IS NULL ORDER BY created DESC,id LIMIT 100').all(caller, this.scope) as unknown as Session[]).map(session => this.summary(db, session)) }))
  }
  async snapshot() {
    await this.initialize()
    const prep = await this.preparation.status()
    const queue = this.queue()
    return this.leases.readStorage(db => {
      const now = this.now()
      const rows = queue.cards.map(card => {
        const prepared = this.packets.currentInStorage(db, card.id)
        const ready = this.packets.claimableInStorage(db, card)
        const leased = this.leases.activeInStorage(this.leases.rowInStorage(db, card.id))
        const revision = queue.revisionFor(card)
        const job = revision ? this.preparation.latestJobInStorage(db, card.id, revision) : undefined
        const state = ready ? 'Ready' : leased ? 'Leased' : prepared ? 'Saving answer' :
          job && isLivePreparation(job, now) ? 'Preparing' :
          job?.state === 'expired' ? 'Retrying' :
          job?.state === 'stopped' ? job.message || 'Preparation stopped' : 'Queued'
        return { card_id: card.id, title: String(card.properties.Name?.value || 'Decision card'), ready, state }
      })
      const ready = rows.flatMap(row => row.ready ? [{ id: row.ready.id, card_id: row.card_id, title: row.title }] : [])
      return { scope: this.scope, observed_at: new Date(now).toISOString(), coverage: queue.coverage,
        counts: { ready: ready.length, leased: rows.filter(row => row.state === 'Leased').length, preparing: prep.preparing },
        runner: prep, ready,
        pending: rows.filter(row => !row.ready).map(({ card_id, title, state }) => ({ card_id, title, state })),
        omissions: queue.coverage === 'complete' ? [] : ['Showing known cards. The board read is incomplete.'] }
    })
  }
  private session(db: DatabaseSync, caller: string, input: Pick<ClaimInput, 'review_session_token' | 'lease_token'>): Session | undefined {
    let session: Session | undefined
    if (input.review_session_token) session = db.prepare('SELECT * FROM decision_review_sessions WHERE token_hash = ? AND caller = ? AND scope = ?').get(leaseHash(input.review_session_token), caller, this.scope) as unknown as Session | undefined
    else if (input.lease_token) session = db.prepare('SELECT s.* FROM decision_review_sessions s JOIN decision_review_bindings b ON b.session_id = s.id WHERE b.token_hash = ? AND s.caller = ? AND s.scope = ?').get(leaseHash(input.lease_token), caller, this.scope) as unknown as Session | undefined
    else return undefined
    if (!session || session.revoked) throw new CardLeaseError(null)
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
    const stored = this.packets.currentInStorage(db, binding.card)
    const valid = stored?.id === binding.packet_id
    return { outcome: valid ? 'held' : 'packet-invalidated', lease: publicLease(row), lease_token: token,
      packet: valid ? workReadback(stored) : null, session_id: session.id }
  }
  private receipt(db: DatabaseSync, caller: string, operation: string, signature: string) {
    const previous = db.prepare('SELECT signature,result FROM decision_review_operations WHERE caller = ? AND scope = ? AND operation = ?').get(caller, this.scope, operation) as { signature: string; result: string } | undefined
    if (previous && previous.signature !== signature) throw new DecisionDeskConflict('Review operation already used with different input')
    return previous ? JSON.parse(previous.result) as { session_id?: string; outcome: string; claim_operation?: string; card_id?: string; card_scope?: string; next_operation_id?: string | null } : null
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
      const result = await this.leases.writeStorage(db => {
        const result = this.claimInStorage(db, caller, holder, parsed)
        this.leases.auditInStorage(db, result.lease?.card_id ?? '', 'prepared-claim', { operation_key: operationKey, outcome: result.outcome, duration_ms: performance.now() - started })
        return result
      })
      return this.verifyClaim(caller, result)
    } catch (error) {
      if (error instanceof CardLeaseError) await this.leases.writeStorage(db => this.leases.auditInStorage(db, parsed.card_id ?? '', 'prepared-claim-conflict', { operation_key: operationKey, outcome: error instanceof SourceWritePending ? 'source-write-pending' : error.lease ? 'card-held' : 'claim-lost', duration_ms: performance.now() - started }))
      throw error
    }
  }
  async verifyClaim(caller: string, result: PreparedClaimResult): Promise<PreparedClaimResult> {
    if (!result.packet || !result.lease || result.outcome === 'already-holding') return result
    const { card_id, generation } = result.lease
    try {
      const source = await this.readSource(card_id)
      return await this.leases.writeStorage(db => {
        const row = this.leases.rowInStorage(db, card_id)
        if (!this.leases.activeInStorage(row) || row.caller !== caller || row.generation !== generation) {
          return { outcome: 'claim-lost', message: 'This chat no longer holds the card.' }
        }
        if (source.actionable && source.revision === result.packet!.packet.source_revision &&
            this.packets.currentInStorage(db, card_id)?.id === result.packet!.id) return result
        const binding = db.prepare('SELECT * FROM decision_review_bindings WHERE session_id = ?').get(result.session_id!) as unknown as PreparedBinding
        if (binding && !this.leases.reservedInStorage(db, card_id) &&
            !this.packets.savingInStorage(db, card_id)) {
          this.finishInStorage(db, caller, binding, 'Card changed before review')
          return { outcome: 'packet-invalidated', packet: null, message: 'The card changed and will be prepared again if it still needs Will.' }
        }
        return { ...result, outcome: 'packet-invalidated', packet: null, message: 'The card changed while held.' }
      })
    } catch {
      return { ...result, outcome: 'source-unavailable', packet: null, message: 'The card could not be read. Retry the claim or release it.' }
    }
  }
  claimInStorage(db: DatabaseSync, caller: string, holder: string, input: ClaimInput, excludeCard?: string): PreparedClaimResult {
    const signature = JSON.stringify(['claim', input.card_id ?? null, input.review_session_token ? leaseHash(input.review_session_token) : null, input.lease_token ? leaseHash(input.lease_token) : null, excludeCard ?? null])
    const previous = this.receipt(db, caller, input.operation_id, signature)
    let session = this.session(db, caller, input)
    if (previous) {
      if (!previous.session_id) return previous
      const previousSession = db.prepare('SELECT * FROM decision_review_sessions WHERE id = ? AND caller = ? AND scope = ?').get(previous.session_id, caller, this.scope) as unknown as Session | undefined
      if (!previousSession || previousSession.revoked) throw new CardLeaseError(null)
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
        const result = input.card_id && held.lease.card_id !== input.card_id ? { ...held, packet: null, outcome: 'already-holding' } : held
        this.record(db, caller, input.operation_id, signature, { outcome: result.outcome, session_id: session.id, claim_operation: binding.claim_operation })
        return result
      }
    }
    const queue = this.queue()
    const cards = input.card_id ? [input.card_id] : queue.cards
    for (const candidate of cards) {
      const card = typeof candidate === 'string' ? candidate : candidate.id
      if (card === excludeCard) continue
      const lease = this.leases.rowInStorage(db, card)
      if (this.leases.activeInStorage(lease) && input.card_id) throw new CardLeaseError(publicLease(lease))
      const packet = this.packets.claimableInStorage(db, candidate)
      if (!packet) continue
      session ??= this.open(db, caller, { operation_id: input.operation_id, label: holder, device: 'other' }, true).session
      const claimOperation = JSON.stringify(['prepared-claim', this.scope, input.operation_id])
      const claim = this.leases.claimInStorage(db, [card], caller, holder, claimOperation, undefined, true)
      if (!('lease' in claim) || !claim.lease || !('lease_token' in claim) || !claim.lease_token) throw new Error('Canonical lease allocation failed')
      // packet_version is retained in existing binding rows for restart compatibility.
      db.prepare('INSERT OR REPLACE INTO decision_review_bindings VALUES(?,?,?,?,?,?,?)').run(session.id, card, claim.lease.generation, packet.id, 1, leaseHash(claim.lease_token), claimOperation)
      const response = { ...this.held(db, session)!, outcome: 'claimed' }
      this.record(db, caller, input.operation_id, signature, { outcome: 'claimed', session_id: session.id, claim_operation: claimOperation })
      return response
    }
    const result = { outcome: queue.coverage === 'unknown' ? 'source-unavailable' : 'no-prepared-decisions',
      message: 'No prepared, unleased card is ready.', coverage: queue.coverage }
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
    if (!session || session.revoked) throw new CardLeaseError(null)
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
    const response = await this.leases.writeStorage(db => {
      const signature = JSON.stringify(['release', parsed.action, parsed.reason, parsed.review_session_token ? leaseHash(parsed.review_session_token) : null, parsed.lease_token ? leaseHash(parsed.lease_token) : null])
      const previous = this.receipt(db, caller, parsed.operation_id, signature)
      if (previous) {
        if (!previous.next_operation_id) return previous
        return { ...previous, next: this.tryContinueInStorage(db, caller, holder, previous.session_id!, previous.next_operation_id, previous.card_id, previous.card_scope) }
      }
      const session = this.session(db, caller, parsed)
      if (!session) throw new CardLeaseError(null)
      const held = this.held(db, session, parsed.lease_token)
      if (!held) throw new CardLeaseError(null)
      const row = this.leases.rowInStorage(db, held.lease.card_id)!
      const binding = db.prepare('SELECT * FROM decision_review_bindings WHERE session_id = ?').get(session.id) as unknown as PreparedBinding
      const cardScope = this.claimScopeInStorage(db, caller, binding)
      if (this.packets.savingInStorage(db, row.card)) throw new SourceWritePending()
      this.leases.releaseInStorage(db, row, parsed.reason, caller)
      db.prepare('DELETE FROM decision_review_bindings WHERE session_id = ?').run(session.id)
      const next = parsed.action !== 'release' ? this.tryContinueInStorage(db, caller, holder, session.id, `skip-next:${parsed.operation_id}`, row.card, cardScope) : null
      // Tokens never enter operation storage; replay resolves the next binding.
      const result = { session_id: session.id, outcome: parsed.action === 'skip' ? 'skipped' : 'released', card_id: row.card, card_scope: cardScope, next_operation_id: parsed.action !== 'release' ? `skip-next:${parsed.operation_id}` : null }
      this.record(db, caller, parsed.operation_id, signature, result)
      return { ...result, next }
    })
    return { ...response, next: 'next' in response && response.next ? await this.verifyClaim(caller, response.next) : null }
  }
  async close(caller: string, token: string, reason: string) {
    await this.initialize()
    return this.leases.writeStorage(db => {
      const session = this.session(db, caller, { review_session_token: token })!
      const held = this.held(db, session)
      if (held) {
        if (this.packets.savingInStorage(db, held.lease.card_id)) throw new SourceWritePending()
        this.leases.releaseInStorage(db, this.leases.rowInStorage(db, held.lease.card_id)!, reason, caller)
      }
      db.prepare('UPDATE decision_review_sessions SET revoked = ? WHERE id = ?').run(this.now(), session.id)
      return { outcome: 'closed' }
    })
  }
}

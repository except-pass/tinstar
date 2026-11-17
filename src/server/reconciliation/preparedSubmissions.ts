import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import { bindingMeaning, decisionMeaning, type DecisionEvidence } from '../../shared/decisionPacket'
import { answerDecisionSchema, type UpdateWorkInput, type StartWorkResult } from '../../shared/workflow'
import { CardLeaseError, leaseHash, withLeaseCaller } from './cardLeases'
import { DecisionDeskConflict, type StoredDecisionPacket } from './decisionPackets'
import { PreparedReviews, type PreparedBinding, type PreparedClaimResult } from './preparedReviews'
import { workReadback } from './workReadback'

type Answer = Extract<UpdateWorkInput, { kind: 'answer_decision' }>
const answerSchema = answerDecisionSchema
export const preparedSubmitInput = z.object({
  operation_id: z.string().min(1).max(128), review_session_token: z.string().min(1).max(256).optional(), lease_token: z.string().min(1).max(256),
  packet_id: z.string().uuid(), packet_version: z.number().int().positive(), request_id: z.string().min(1).max(128), option_id: z.string().min(1).max(128),
  next: answerSchema.shape.next, resolve_wait: answerSchema.shape.resolve_wait.unwrap().max(12000).optional(),
  original_lease_token: z.string().min(1).max(256).optional(),
  confirmation: z.object({ option_id: z.string(), scope: z.string() }).strict().optional(),
}).strict()
export const preparedRecoveryInput = z.object({ review_session_token: z.string().min(1).max(256).optional(), lease_token: z.string().min(1).max(256).optional(), original_lease_token: z.string().min(1).max(256).optional() }).strict()
type Input = z.infer<typeof preparedSubmitInput>
export interface PreparedAnswerSource {
  observe(input: Answer, actor: string): Promise<{ state: 'absent' | 'pending' | 'confirmed' | 'conflict'; original?: Record<string, unknown>; desired?: Record<string, unknown>; ownIntentId?: string }>
  evidence(packet: StoredDecisionPacket, original?: Record<string, unknown>, desired?: Record<string, unknown>, ownIntentId?: string): Promise<DecisionEvidence>
  write(input: Answer, actor: string): Promise<StartWorkResult>
  scheduleReconciliation?(card: string): void
}
interface Attempt {
  caller: string; scope: string; operation: string; signature: string; session_id: string; binding: string; selection: string; answer: string; actor: string;
  state: string; detail: string; created: number; confirmed: number | null; finished: number | null
}
type SubmissionBinding = PreparedBinding & { next_card_scope?: string | null }
export interface PreparedSubmitResult {
  outcome: string; operation_id: string; selection: { packet_id: string; packet_version: number; request_id: string; option_id: string };
  message: string; source_state?: string; saved_fields?: string[]; reasons?: string[]; observed_at?: string | null;
  confirmation?: unknown; next?: PreparedClaimResult; card_progress?: 'partial' | 'confirmed-request'; progress?: Array<{ request_id: string; confirmed_at: string }>;
}

/** Durable desk recovery, not an alternate answer channel. Only the existing
 * workflow writer touches the source; receipts are read before every retry.
 * The canonical source-write reservation fences ambiguous provider requests. */
export class PreparedSubmissions {
  private initialized?: Promise<void>
  constructor(readonly reviews: PreparedReviews, private source: PreparedAnswerSource, private now = Date.now) {}
  private get leases() { return this.reviews.packets.leases }
  async initialize() {
    await this.reviews.initialize()
    return this.initialized ??= this.leases.writeStorage(db => { db.exec(`
      CREATE TABLE IF NOT EXISTS decision_desk_submissions (
        caller TEXT NOT NULL, scope TEXT NOT NULL, operation TEXT NOT NULL, signature TEXT NOT NULL,
        session_id TEXT NOT NULL, binding TEXT NOT NULL, selection TEXT NOT NULL, answer TEXT NOT NULL, actor TEXT NOT NULL,
        state TEXT NOT NULL, detail TEXT NOT NULL, created INTEGER NOT NULL, confirmed INTEGER, finished INTEGER,
        PRIMARY KEY(caller,scope,operation));
      CREATE TABLE IF NOT EXISTS decision_desk_confirmed_answers (
        scope TEXT NOT NULL, card TEXT NOT NULL, request_id TEXT NOT NULL, source_revision TEXT NOT NULL,
        packet_id TEXT NOT NULL, operation_key TEXT NOT NULL, confirmed INTEGER NOT NULL,
        PRIMARY KEY(scope,card,request_id,source_revision));
      CREATE TABLE IF NOT EXISTS decision_desk_recording (
        scope TEXT PRIMARY KEY, started INTEGER NOT NULL);`); db.prepare('INSERT OR IGNORE INTO decision_desk_recording VALUES(?,?)').run(this.reviews.scope, this.now()) })
  }
  private read(db: DatabaseSync, caller: string, operation: string) {
    return db.prepare('SELECT * FROM decision_desk_submissions WHERE caller = ? AND scope = ? AND operation = ?').get(caller, this.reviews.scope, operation) as unknown as Attempt | undefined
  }
  private signature(input: Input) {
    const { review_session_token: _session, lease_token: _lease, original_lease_token: _original, packet_id: _packet, packet_version: _version, confirmation: _confirmation, ...meaning } = input
    return decisionMeaning(meaning)
  }
  private selection(input: Input) {
    return { packet_id: input.packet_id, packet_version: input.packet_version, request_id: input.request_id, option_id: input.option_id }
  }
  private response(attempt: Attempt, outcome: string, message: string, extra: Partial<PreparedSubmitResult> = {}): PreparedSubmitResult {
    const binding: PreparedBinding = JSON.parse(attempt.binding)
    const progress = this.leases.readStorage(db => db.prepare('SELECT request_id,confirmed FROM decision_desk_confirmed_answers WHERE scope = ? AND card = ? ORDER BY confirmed,request_id').all(this.reviews.scope, binding.card) as Array<{ request_id: string; confirmed: number }>)
    return { outcome, operation_id: attempt.operation, selection: JSON.parse(attempt.selection), message,
      card_progress: progress.length ? (attempt.confirmed !== null || outcome.startsWith('recorded') ? 'confirmed-request' : 'partial') : undefined, progress: progress.map(row => ({ request_id: row.request_id, confirmed_at: new Date(row.confirmed).toISOString() })), ...extra }
  }
  private async state(attempt: Attempt, state: string, detail: unknown) {
    await this.leases.writeStorage(db => {
      // A late failure from a concurrent retry cannot overwrite durable success.
      const current = this.read(db, attempt.caller, attempt.operation)
      if (current?.state === 'superseded') throw new DecisionDeskConflict('Selection was superseded before saving; no source write permitted')
      db.prepare('UPDATE decision_desk_submissions SET state = ?,detail = ? WHERE caller = ? AND scope = ? AND operation = ? AND confirmed IS NULL').run(state, JSON.stringify(detail), attempt.caller, attempt.scope, attempt.operation)
      db.prepare('INSERT INTO decision_packet_events(packet_id,type,actor,at,detail) VALUES(?,?,?,?,?)').run(JSON.parse(attempt.binding).packet_id, 'answer-attempt', attempt.caller, new Date(this.now()).toISOString(), JSON.stringify({ state }))
      this.leases.auditInStorage(db, JSON.parse(attempt.binding).card, 'prepared-submit-result', { operation_key: leaseHash(attempt.signature), outcome: state, duration_ms: this.now() - attempt.created })
    })
  }
  async submit(caller: string, holder: string, actor: string, value: unknown): Promise<PreparedSubmitResult> {
    const input = preparedSubmitInput.parse(value)
    await this.initialize()
    let attempt: Attempt
    try {
      attempt = await this.leases.writeStorage(db => {
        const prior = this.read(db, caller, input.operation_id)
        if (prior && (prior.signature !== this.signature(input) || prior.actor !== actor)) throw new DecisionDeskConflict('Submit operation already used with different input')
        // Completed operation replay is authorized by its original capability,
        // even after advance/expiry; it cannot release or write a newer card.
        if (prior) {
          const oldBinding: SubmissionBinding = JSON.parse(prior.binding)
          const oldSelection: PreparedSubmitResult['selection'] = JSON.parse(prior.selection)
          if (oldBinding.token_hash !== leaseHash(input.lease_token) || oldSelection.packet_id !== input.packet_id || oldSelection.packet_version !== input.packet_version) {
            if (prior.confirmed !== null) throw new DecisionDeskConflict('A recorded operation cannot be rebound to another packet')
            const held = this.reviews.submissionInStorage(db, caller, input)
            // A fresh research version can recover the same source operation,
            // never a changed question/options/request revision or broader scope.
            const oldPacket = this.reviews.packets.readInStorage(db, oldBinding.packet_id)
            const fresh = this.reviews.packets.readInStorage(db, held.binding.packet_id)
            const sameContext = held.session_id === prior.session_id || input.original_lease_token && leaseHash(input.original_lease_token) === oldBinding.token_hash
            if (!sameContext || held.binding.packet_id !== input.packet_id || held.binding.packet_version !== input.packet_version || !oldPacket || !fresh ||
              bindingMeaning(oldPacket.packet.binding) !== bindingMeaning(fresh.packet.binding) || decisionMeaning(oldPacket.packet.authorization) !== decisionMeaning(fresh.packet.authorization)) throw new CardLeaseError(null)
            const nextCardScope = oldBinding.next_card_scope === undefined ? this.reviews.claimScopeInStorage(db, caller, oldBinding) ?? null : oldBinding.next_card_scope
            prior.binding = JSON.stringify({ ...held.binding, next_card_scope: nextCardScope }); prior.session_id = held.session_id; prior.selection = JSON.stringify(this.selection(input))
            db.prepare('UPDATE decision_desk_submissions SET binding = ?,session_id = ?,selection = ? WHERE caller = ? AND scope = ? AND operation = ?').run(prior.binding, prior.session_id, prior.selection, caller, prior.scope, prior.operation)
            this.leases.auditInStorage(db, held.binding.card, 'prepared-submit-reclaimed', { operation_key: leaseHash(JSON.stringify([caller, input.operation_id])), packet_id: fresh.id, packet_version: fresh.version, generation: held.binding.generation })
          }
          return prior
        }
        const held = this.reviews.submissionInStorage(db, caller, input)
        if (held.binding.packet_id !== input.packet_id || held.binding.packet_version !== input.packet_version) throw new DecisionDeskConflict('Selection must name the packet version held by this session')
        const stored = this.reviews.packets.readInStorage(db, input.packet_id)
        if (!stored || stored.packet.binding.request_id !== input.request_id) throw new DecisionDeskConflict('Selection must name the exact held source request')
        const option = stored.packet.binding.options.find(option => option.id === input.option_id)
        if (!option) throw new DecisionDeskConflict('Selection must use this source request option vocabulary')
        if (input.next.owner !== stored.packet.authorization.next_owner || input.next.status !== stored.packet.authorization.next_status) throw new DecisionDeskConflict('Next owner and status must match the prepared authorization scope')
        const answer = answerSchema.parse({ kind: 'answer_decision', card_id: held.binding.card, operation_id: input.operation_id,
          request_id: input.request_id, option_id: input.option_id, answer: option.label, ...(stored.packet.binding.source_request ? { source_request: stored.packet.binding.source_request } : {}),
          next: input.next, ...(input.resolve_wait ? { resolve_wait: input.resolve_wait } : {}) })
        const other = db.prepare(`SELECT operation,state,caller FROM decision_desk_submissions WHERE scope = ? AND json_extract(answer,'$.card_id') = ?
          AND json_extract(answer,'$.request_id') = ? AND state NOT IN ('not-saved','packet-invalidated','answer-conflict','superseded') LIMIT 1`).get(this.reviews.scope, answer.card_id, answer.request_id) as { operation: string; state: string; caller: string } | undefined
        if (other?.state === 'selected') db.prepare("UPDATE decision_desk_submissions SET state = 'superseded' WHERE caller = ? AND scope = ? AND operation = ?").run(other.caller, this.reviews.scope, other.operation)
        else if (other) throw new DecisionDeskConflict('This source request has a retained submission; reconcile the original operation ID before selecting another answer')
        const row: Attempt = { caller, scope: this.reviews.scope, operation: input.operation_id, signature: this.signature(input), session_id: held.session_id,
          binding: JSON.stringify({ ...held.binding, next_card_scope: this.reviews.claimScopeInStorage(db, caller, held.binding) ?? null }),
          selection: JSON.stringify(this.selection(input)), answer: JSON.stringify(answer), actor,
          state: 'selected', detail: '{}', created: this.now(), confirmed: null, finished: null }
        db.prepare('INSERT INTO decision_desk_submissions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values(row))
        db.prepare('INSERT OR IGNORE INTO decision_desk_recording VALUES(?,?)').run(row.scope, this.now())
        return row
      })
    } catch (error) {
      if (!(error instanceof CardLeaseError)) throw error
      return { outcome: 'lease-lost', operation_id: input.operation_id, selection: this.selection(input), message: 'Lease expired or lost. Re-claim and revalidate before submitting. Your selection is retained.' }
    }
    if (attempt.confirmed !== null) return this.finish(attempt, holder)
    const { next_card_scope: _nextCardScope, ...binding }: SubmissionBinding = JSON.parse(attempt.binding)
    const answer: Answer = JSON.parse(attempt.answer)
    const stored = await this.reviews.packets.read(input.packet_id)
    if (!stored) return this.response(attempt, 'packet-invalidated', 'Packet unavailable. Your selection is retained.')
    const confirmation = { option_id: input.option_id, selected_option: answer.answer, scope: stored.packet.authorization.scope,
      adverse_impact: stored.packet.risk.explanation, blast_radius: stored.packet.risk.blast_radius,
      reversibility: stored.packet.reversibility, next: stored.packet.authorization }
    try {
      const observation = await withLeaseCaller(caller, input.lease_token, () => this.source.observe(answer, actor))
      if (observation.state === 'conflict') {
        await this.state(attempt, 'answer-conflict', {})
        return this.response(attempt, 'answer-conflict', 'A different source answer or intent exists. Your selection is retained; no write was submitted.')
      }
      if (observation.state !== 'confirmed') {
        // Even a retry of an old selection must hold a currently valid generation.
        await this.leases.writeStorage(db => {
          const held = this.reviews.submissionInStorage(db, caller, input)
          if (decisionMeaning(held.binding) !== decisionMeaning(binding)) throw new CardLeaseError(null)
        })
        if ((stored.packet.risk.rating === 'High' || stored.packet.reversibility.rating === 'Difficult') &&
          (input.confirmation?.option_id !== input.option_id || input.confirmation.scope !== confirmation.scope)) {
          return this.response(attempt, 'confirmation-required', 'Confirm the selected option and its explicit authorization scope before saving.', { confirmation: workReadback(confirmation) })
        }
        const evidence = await this.source.evidence(stored, observation.original, observation.desired, observation.ownIntentId)
        const current = await this.reviews.packets.read(stored.id, evidence)
        if (!current?.validation.valid || !current.validation.valid_until || Date.parse(current.validation.valid_until) <= this.now()) {
          const request = evidence.requests.find(request => request.binding?.request_id === input.request_id)
          const unavailable = evidence.reasons.some(reason => /unavailable|incomplete|unknown|partial/i.test(reason)) || !request?.binding || request.dependencies.some(dependency => dependency.status !== 'fresh' || dependency.coverage !== 'complete')
          const outcome = unavailable ? 'source-unavailable' : 'packet-invalidated'
          await this.reviews.packets.validate(stored.id, evidence, caller)
          await this.state(attempt, observation.state === 'pending' ? 'blocked-recovery' : unavailable ? 'not-saved' : 'packet-invalidated', { reasons: current?.validation.reasons })
          return this.response(attempt, outcome, unavailable ? 'Source verification is unavailable or stale. Your selection is retained; refresh evidence before deciding.' : 'Packet invalidated — source revision changed. Refresh research before deciding.', { reasons: workReadback(current?.validation.reasons), observed_at: evidence.observed_at })
        }
        await this.state(attempt, 'saving', {})
        const result = await withLeaseCaller(caller, input.lease_token, () => this.source.write(answer, actor))
        // A writer success is necessary but read the exact authoritative answer
        // again: saved_fields may contain only the intent or one property.
        const readback = await withLeaseCaller(caller, input.lease_token, () => this.source.observe(answer, actor))
        if (readback.state !== 'confirmed') {
          const state = readback.state === 'conflict' ? 'answer-conflict' : result.outcome === 'not-saved' && readback.state === 'absent' && !['source-write-pending', 'save-unconfirmed'].includes(result.code) ? 'not-saved' : 'save-unconfirmed'
          await this.state(attempt, state, { code: result.code, saved_fields: result.saved_fields })
          return this.response(attempt, state, state === 'not-saved' ? 'Answer was not saved. Your selection is retained. Retry without advancing.' : 'Save status unconfirmed — confirming result. Retry the same operation ID; your selection and lease are retained.', { source_state: result.code, saved_fields: result.saved_fields })
        }
      }
      await this.leases.writeStorage(db => {
        const confirmed = this.now()
        db.prepare("UPDATE decision_desk_submissions SET state = 'confirmed',confirmed = coalesce(confirmed,?) WHERE caller = ? AND scope = ? AND operation = ?").run(confirmed, caller, attempt.scope, attempt.operation)
        const inserted = db.prepare('INSERT OR IGNORE INTO decision_desk_confirmed_answers VALUES(?,?,?,?,?,?,?)').run(attempt.scope, binding.card, answer.request_id, stored.packet.binding.source_revision, stored.id, leaseHash(JSON.stringify([caller, attempt.operation])), confirmed)
        if (inserted.changes) {
          db.prepare('INSERT INTO decision_packet_events(packet_id,type,actor,at,detail) VALUES(?,?,?,?,?)').run(stored.id, 'answer-confirmed', caller, new Date(confirmed).toISOString(), JSON.stringify({ request_id: answer.request_id, operation_key: leaseHash(JSON.stringify([caller, attempt.operation])), duration_ms: confirmed - attempt.created }))
        }
      })
      return this.finish(attempt, holder)
    } catch (error) {
      if (error instanceof DecisionDeskConflict) return this.response(attempt, 'not-saved', error.message)
      if (error instanceof CardLeaseError) return this.response(attempt, 'lease-lost', 'Lease expired or lost. Re-claim and revalidate before submitting. Your selection is retained.')
      const latest = this.leases.readStorage(db => this.read(db, caller, attempt.operation))!
      const state = ['selected', 'not-saved', 'packet-invalidated'].includes(latest.state) ? 'not-saved' : 'save-unconfirmed'
      await this.state(attempt, state, { code: 'source-unavailable' })
      return this.response(attempt, state, state === 'not-saved' ? 'Answer was not saved. Source verification is unavailable. Your selection is retained. Retry without advancing.' : 'Save status unconfirmed — confirming result. Retry the same operation ID; no blind second write will be sent.')
    }
  }
  private async finish(attempt: Attempt, holder: string): Promise<PreparedSubmitResult> {
    const binding: SubmissionBinding = JSON.parse(attempt.binding)
    try {
      const next = await this.leases.writeStorage(db => {
        const row = this.read(db, attempt.caller, attempt.operation)!
        if (row.confirmed === null) throw new Error('Source confirmation required before release')
        if (row.finished === null) {
          this.reviews.finishInStorage(db, attempt.caller, binding, 'Decision source answer confirmed')
          db.prepare("UPDATE decision_desk_submissions SET state = 'recorded',finished = ? WHERE caller = ? AND scope = ? AND operation = ?").run(this.now(), attempt.caller, attempt.scope, attempt.operation)
        }
        const cardScope = binding.next_card_scope === undefined ? this.reviews.claimScopeInStorage(db, attempt.caller, binding) : binding.next_card_scope ?? undefined
        const result = this.reviews.tryContinueInStorage(db, attempt.caller, holder, attempt.session_id, `submit-next:${leaseHash(attempt.operation)}`, undefined, cardScope)
        this.leases.auditInStorage(db, binding.card, 'prepared-submit-to-next', { operation_key: leaseHash(JSON.stringify([attempt.caller, attempt.operation])), outcome: result.outcome, duration_ms: this.now() - attempt.created, source_readback_ms: row.confirmed - attempt.created })
        return result
      })
      // Dispatch only after release/next commits: receipt writes must not race
      // the canonical release transaction or delay advancement on a slow worker.
      try { this.source.scheduleReconciliation?.(binding.card) } catch { /* Source recording is independent of bridge availability. */ }
      return this.response(attempt, next.lease ? 'recorded' : 'recorded-empty', 'Recorded; awaiting worker acknowledgment.', { source_state: 'recorded-awaiting-worker-acknowledgment', next })
    } catch {
      return this.response(attempt, 'recorded-releasing', 'Decision recorded; releasing the previous lease is pending. Retry the same operation ID.', { source_state: 'recorded-awaiting-worker-acknowledgment' })
    }
  }
  async recover(caller: string, input: z.infer<typeof preparedRecoveryInput>) {
    await this.initialize()
    return this.leases.readStorage(db => {
      const sessionId = this.reviews.contextInStorage(db, caller, input)
      const rows = db.prepare(`SELECT * FROM decision_desk_submissions WHERE caller = ? AND scope = ? AND (session_id = ? OR json_extract(binding,'$.token_hash') = ?)
        AND finished IS NULL AND state != 'superseded' ORDER BY created DESC LIMIT 20`).all(caller, this.reviews.scope, sessionId, input.original_lease_token ? leaseHash(input.original_lease_token) : '') as unknown as Attempt[]
      return { submissions: rows.map(row => {
        const answer: Answer = JSON.parse(row.answer)
        return { operation_id: row.operation, selection: JSON.parse(row.selection), state: row.state,
          binding_matches_original_lease: !!input.original_lease_token && JSON.parse(row.binding).token_hash === leaseHash(input.original_lease_token),
          next: workReadback(answer.next), resolve_wait: workReadback(answer.resolve_wait?.trim()), confirmed_at: row.confirmed === null ? null : new Date(row.confirmed).toISOString(),
          detail: workReadback(JSON.parse(row.detail)), recovery: 'Retry the original operation ID and selection after reclaiming/revalidating an expired lease. Ambiguous provider writes use the existing audited source-write reconciliation API.' }
      }) }
    })
  }
  async metrics() {
    await this.initialize()
    return this.leases.readStorage(db => {
      const start = db.prepare('SELECT started FROM decision_desk_recording WHERE scope = ?').get(this.reviews.scope) as { started: number } | undefined
      const from = Date.parse(new Date(this.now()).toISOString().slice(0, 10) + 'T00:00:00Z')
      const count = db.prepare('SELECT count(*) AS n FROM decision_desk_confirmed_answers WHERE scope = ? AND confirmed >= ?').get(this.reviews.scope, from) as { n: number }
      return { scope: this.reviews.scope, reviewed_today_utc: count.n, recording_started_at: start ? new Date(start.started).toISOString() : null,
        omissions: ['Decision Desk confirmed source requests only, since recording began; independent requests are not a multipart bundle. Worker acknowledgment is asynchronous.'] }
    })
  }
}

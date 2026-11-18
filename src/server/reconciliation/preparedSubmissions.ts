import { z } from 'zod'
import { leaseHash, CardLeaseError, SourceWritePending, withLeaseCaller } from './cardLeases'
import { DecisionDeskConflict, type StoredDecisionPacket } from './decisionPackets'
import { type PreparedBinding, type PreparedClaimResult, type PreparedReviews } from './preparedReviews'
import { workReadback } from './workReadback'

export const preparedSubmitInput = z.object({
  operation_id: z.string().min(1).max(128),
  review_session_token: z.string().min(1).max(256).optional(),
  lease_token: z.string().min(1).max(256),
  option_id: z.string().min(1).max(128),
  answer: z.string().max(12000).refine(text => text.trim().length > 0, 'Enter the answer'),
})
export const preparedRecoveryInput = z.object({
  review_session_token: z.string().min(1).max(256).optional(),
  lease_token: z.string().min(1).max(256).optional(),
})
type Input = z.infer<typeof preparedSubmitInput>
type Selection = Pick<Input, 'option_id' | 'answer'>
interface Attempt {
  card: string
  caller: string
  operation: string
  binding: string
  input: string
  state: 'saving' | 'recorded'
}
export interface PreparedSubmitResult {
  outcome: string
  operation_id: string
  message: string
  next?: PreparedClaimResult
}
export type RecordDeskAnswer = (stored: StoredDecisionPacket, selected: Selection, operation: string) =>
  Promise<{ outcome: 'recorded' | 'packet-invalidated' | 'not-saved'; message?: string }>

export class PreparedSubmissions {
  constructor(private reviews: PreparedReviews, private writeAnswer: RecordDeskAnswer, private now = Date.now) {}
  private get leases() { return this.reviews.packets.leases }
  private get scope() { return this.reviews.scope }

  async submit(caller: string, holder: string, input: unknown): Promise<PreparedSubmitResult> {
    const parsed = preparedSubmitInput.parse(input)
    const { operation_id, option_id, answer } = parsed
    const outcome = (state: string, message: string, next?: PreparedClaimResult) =>
      ({ outcome: state, operation_id, message, ...(next ? { next } : {}) })
    await this.reviews.initialize()
    try {
      const selected = JSON.stringify({ option_id, answer })
      const { attempt, stored } = await this.leases.writeStorage(db => {
        const previous = db.prepare('SELECT * FROM decision_card_answers WHERE scope = ? AND caller = ? AND operation = ?')
          .get(this.scope, caller, operation_id) as unknown as Attempt | undefined
        if (previous) {
          const binding = JSON.parse(previous.binding) as PreparedBinding
          if (binding.token_hash !== leaseHash(parsed.lease_token)) throw new CardLeaseError(null)
          if (previous.input !== selected) throw new DecisionDeskConflict('operation_id already has a different answer')
          if (previous.state !== 'recorded') this.leases.resumeDeskWriteInStorage(db, caller, binding)
          return { attempt: previous, stored: this.reviews.packets.readInStorage(db, binding.packet_id)! }
        }
        const { binding } = this.reviews.submissionInStorage(db, caller, parsed)
        const stored = this.reviews.packets.currentInStorage(db, binding.card)
        if (!stored || stored.id !== binding.packet_id) return { attempt: null, stored: null }
        if (!stored.packet.options.some(option => option.id === option_id)) throw new DecisionDeskConflict('option_id is unavailable on the held packet')
        if (this.reviews.packets.savingInStorage(db, binding.card)) throw new SourceWritePending()
        const attempt: Attempt = { card: binding.card, caller, operation: operation_id, binding: JSON.stringify(binding), input: selected, state: 'saving' }
        db.prepare('INSERT INTO decision_card_answers (scope,card,caller,operation,binding,input,state) VALUES (?,?,?,?,?,?,?)')
          .run(this.scope, attempt.card, caller, operation_id, attempt.binding, attempt.input, attempt.state)
        return { attempt, stored }
      })
      if (!attempt || !stored) return outcome('packet-invalidated', 'The card changed. Release it to continue.')
      const binding = JSON.parse(attempt.binding) as PreparedBinding
      let message = 'Decision recorded on the card.'
      if (attempt.state !== 'recorded') {
        const result = await withLeaseCaller(caller, parsed.lease_token,
          () => this.writeAnswer(stored, { option_id, answer }, `desk:${leaseHash(JSON.stringify([caller, operation_id]))}`))
        message = result.message ?? message
        if (result.outcome !== 'recorded') {
          await this.leases.writeStorage(db => {
            if (result.outcome === 'packet-invalidated' && this.reviews.packets.currentInStorage(db, attempt.card)?.id === stored.id) {
              this.reviews.packets.invalidateInStorage(db, attempt.card)
            }
            db.prepare("DELETE FROM decision_card_answers WHERE scope = ? AND caller = ? AND operation = ? AND state = 'saving'")
              .run(this.scope, caller, operation_id)
          })
          return outcome(result.outcome, result.message ?? 'The card changed. Release it to continue.')
        }
      }
      const next = await this.leases.writeStorage(db => {
        db.prepare("UPDATE decision_card_answers SET state = 'recorded', confirmed_at = coalesce(confirmed_at,?) WHERE scope = ? AND caller = ? AND operation = ?")
          .run(new Date(this.now()).toISOString(), this.scope, caller, operation_id)
        if (this.reviews.packets.currentInStorage(db, attempt.card)?.id === stored.id) {
          this.reviews.packets.invalidateInStorage(db, attempt.card)
        }
        this.reviews.finishInStorage(db, caller, binding, 'Decision answer recorded')
        const cardScope = this.reviews.claimScopeInStorage(db, caller, binding)
        return this.reviews.tryContinueInStorage(db, caller, holder, binding.session_id, `submit-next:${leaseHash(operation_id)}`, attempt.card, cardScope)
      })
      const verified = await this.reviews.verifyClaim(caller, next)
      return outcome(verified.packet ? 'recorded' : 'recorded-empty', message, verified)
    } catch (error) {
      if (error instanceof SourceWritePending) return outcome('save-unconfirmed', 'An earlier write is pending. Retry its original operation.')
      if (error instanceof CardLeaseError) return outcome('lease-lost', 'This chat no longer holds the card.')
      if (error instanceof DecisionDeskConflict) return outcome('not-saved', error.message)
      return outcome('save-unconfirmed', 'Could not confirm the save. Retry with the same answer and operation ID.')
    }
  }

  async recover(caller: string, input: z.infer<typeof preparedRecoveryInput>) {
    await this.reviews.initialize()
    return this.leases.readStorage(db => {
      const sessionId = this.reviews.contextInStorage(db, caller, input)
      const rows = db.prepare("SELECT card,operation,input FROM decision_card_answers WHERE scope = ? AND caller = ? AND json_extract(binding,'$.session_id') = ? AND state = 'saving'")
        .all(this.scope, caller, sessionId) as Array<{ card: string; operation: string; input: string }>
      return workReadback({ submissions: rows.map(row => ({ card_id: row.card, operation_id: row.operation, ...JSON.parse(row.input) as Selection })) })
    })
  }

  async metrics() {
    await this.reviews.initialize()
    return this.leases.readStorage(db => {
      const day = new Date(this.now()).toISOString().slice(0, 10)
      const count = db.prepare("SELECT count(*) AS n FROM decision_card_answers WHERE scope = ? AND confirmed_at >= ?")
        .get(this.scope, day) as { n: number }
      return { scope: this.scope, reviewed_today_utc: count.n }
    })
  }
}

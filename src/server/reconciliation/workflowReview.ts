import { createHash } from 'node:crypto'
import { legacyReviewKey, isReviewStatus, reviewIdentity, reviewResponsePrefix, reviewSubmissionPrefix, reviewSubmissions } from '../../shared/reviews'
import type { UpdateWorkInput, StartWorkResult } from '../../shared/workflow'
import { NotionWriteError, type WorkflowContent } from './workflowContent'
import type { CreationReceipts, ReviewReceiptState } from './workflowReceipts'
import type { WorkCard, WorkReader } from './workReader'
import type { WorkflowChange } from './workflow'

export type ReviewOperation = Extract<UpdateWorkInput, { kind: 'submit_for_review' | 'accept_review' | 'request_review_changes' }>
export const isReviewOperation = (input: UpdateWorkInput): input is ReviewOperation => ['submit_for_review', 'accept_review', 'request_review_changes'].includes(input.kind)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export class ReviewWriteError extends Error { constructor(readonly code: string, message: string) { super(message) } }
interface Dependencies {
  reader: WorkReader; content: WorkflowContent; receipts: CreationReceipts
  property: (card: WorkCard, field: string, value: unknown) => unknown
  validate: (input: Extract<ReviewOperation, { kind: 'submit_for_review' }>) => Promise<void>
  changed: (change: WorkflowChange) => Promise<void>
}

/** Runs inside the existing per-card workflow lock. Durable receipts retain only
 * narrow review recovery; source state and canonical card history remain truth. */
export async function writeReview(input: ReviewOperation, actor: string, deps: Dependencies): Promise<StartWorkResult> {
  let card: WorkCard | undefined, state: ReviewReceiptState | undefined, attempted = false
  const saved: string[] = []
  const result = (outcome: StartWorkResult['outcome'], code: string, message: string): StartWorkResult => ({ outcome, code, message, operation_id: input.operation_id, saved_fields: saved, ...(card ? { card } : {}) })
  try {
    if (!actor.trim()) throw new ReviewWriteError('unauthenticated', 'Authenticated caller required')
    card = await deps.reader.card(input.card_id, true)
    if (input.kind === 'submit_for_review') {
      if (input.review.proof.tested_sha !== input.review.deployed_sha) throw new ReviewWriteError('review-proof-mismatch', 'Live proof must identify the actual deployed SHA')
      await deps.validate(input)
    }
    const before = card, notes = await deps.content.notes(card.id)
    const submissions = reviewSubmissions(notes)
    const submission = input.kind === 'submit_for_review' ? input.review : submissions.find(row => row.submission_key === input.submission_key)
    const legacy = input.kind !== 'submit_for_review' && input.submission_key.startsWith(`legacy:${card.id}:`)
    if (!submission && !legacy) throw new ReviewWriteError('review-missing', 'Read the recorded review submission before responding')
    const submissionKey = submission?.submission_key ?? (input.kind !== 'submit_for_review' ? input.submission_key : '')
    const identity = submission ? reviewIdentity(card.id, submission) : JSON.stringify([card.id, submissionKey])
    const receiptKey = `review:${input.kind === 'submit_for_review' ? 'submit' : 'response'}:${identity}`
    const marker = `Tin Star review operation: ${digest(receiptKey)}`
    const semantic = input.kind === 'submit_for_review' ? { kind: input.kind, review: { ...input.review, submission_key: undefined, pulls: [...input.review.pulls].sort((a, b) => a.url.localeCompare(b.url)), remaining_scope: [...input.review.remaining_scope].sort(), proof: input.review.proof.kind === 'ui' ? { ...input.review.proof, screenshots: [...input.review.proof.screenshots].sort() } : input.review.proof } }
      : { kind: input.kind, submission_key: input.submission_key, feedback: input.feedback, remaining_scope: [...input.remaining_scope].sort(), scope_complete: input.scope_complete }
    const signature = JSON.stringify(semantic)
    const previous = await deps.receipts.get(receiptKey)
    state = previous?.review
    // Completed submission wins across callers, keys and restarts; it never
    // resets an In review card or resurrects an already answered deliverable.
    const existing = submissions.find(row => reviewIdentity(card!.id, row) === identity)
    if (input.kind === 'submit_for_review' && existing && (!state || state.done)) {
      deps.reader.confirm(card); saved.push('note')
      return result('saved', 'already-submitted', `Review already recorded as ${existing.submission_key}; current status and feedback preserved`)
    }
    if (previous && previous.input !== signature) throw new ReviewWriteError('review-conflict', 'This deliverable already has a different pending submission or recorded response; reconcile that operation first')
    if (notes.some(note => note.text.split('\n').includes(marker))) {
      if (state && !state.done) await deps.receipts.putReview(receiptKey, signature, card.id, { ...state, done: true, note_pending: false })
      deps.reader.confirm(card); saved.push('note')
      return result('saved', 'already-saved', 'Recorded review operation confirmed; current status and feedback preserved')
    }
    if (state?.done) throw new ReviewWriteError('review-history-missing', 'The recorded review note is no longer readable; inspect card history before another write')
    if (card.archived || card.in_trash) throw new ReviewWriteError('card-archived', 'Archived cards cannot be changed by pending review recovery')
    if (input.kind !== 'submit_for_review' && !legacy && submissions.at(-1)?.submission_key !== submissionKey) throw new ReviewWriteError('review-changed', 'A different deliverable is now current; the old response was not replayed')
    if (!state) {
      if (legacy && submissions.length) throw new ReviewWriteError('review-history-required', 'This card has structured review evidence; load its current review evidence and respond with that submission key')
      const otherPending = (await deps.receipts.list('review:')).some(([key, receipt]) => key !== receiptKey && receipt.cardId === card!.id && receipt.review && !receipt.review.done)
      if (otherPending) throw new ReviewWriteError('review-pending', 'Another review operation on this card is unconfirmed; reconcile its source before starting a new one')
      if (input.kind === 'submit_for_review' && isReviewStatus(card.properties.Status?.value) && submissions.length && !existing) throw new ReviewWriteError('review-active', 'Another deliverable is being reviewed; preserve its place and use a scoped child card for separate acceptance')
      if (card.archived || card.in_trash) throw new ReviewWriteError('card-archived', 'Archived cards cannot enter review')
      if (input.expected && Object.entries(input.expected).some(([field, value]) => !same(card!.properties[field]?.value ?? null, value))) throw new ReviewWriteError('conflict', 'Card preconditions changed; refresh before submitting')
      const desired: Record<string, unknown> = { 'Last touched by': actor }
      if (input.kind === 'submit_for_review') {
        if (submissions.some(row => row.submission_key === input.review.submission_key)) throw new ReviewWriteError('review-key-conflict', 'Submission key already belongs to a different deliverable/revision')
        Object.assign(desired, { Owner: 'Will', Status: card.properties.Status?.value === 'In review' ? 'In review' : 'Ready for Review' })
      } else {
        if (!isReviewStatus(card.properties.Status?.value) || (legacy ? input.submission_key !== legacyReviewKey(card.id, card.last_edited_time) : submissions.at(-1)?.submission_key !== submissionKey)) throw new ReviewWriteError('review-changed', 'This is not the currently active review; refresh the card')
        Object.assign(desired, { Owner: 'Firstmate', Status: 'Queued' })
      }
      if (!card.properties.Area?.value) throw new ReviewWriteError('required-fields', 'Review transition requires Area')
      // Validate property types before persisting or writing anything.
      for (const [field, value] of Object.entries(desired)) deps.property(card, field, value)
      const original = Object.fromEntries([...new Set([...Object.keys(desired), 'Waiting For', 'Sub-item'])].map(field => [field, card!.properties[field]?.value ?? null]))
      const note = input.kind === 'submit_for_review' ? `${reviewSubmissionPrefix}${JSON.stringify(input.review)}`
        : `${reviewResponsePrefix}${JSON.stringify({ submission_key: submissionKey, action: input.kind, accepted_by: input.kind === 'accept_review' ? 'Will' : null, recorded_by: actor, feedback: input.feedback, remaining_scope: input.remaining_scope, next_status: desired.Status })}`
      state = { input, original, desired, note: `Date: ${new Date().toISOString()}\nBy: ${actor}\n${note}`, actor }
      await deps.receipts.putReview(receiptKey, signature, card.id, state)
    }
    if (state.note_pending && input.retry_missing_note) {
      state = { ...state, note_pending: false, recovery_reason: input.retry_missing_note.reason }
      await deps.receipts.putReview(receiptKey, signature, card.id, state)
    }
    if (state.note_pending) return result('partially-saved', 'review-note-unconfirmed', 'A prior comment may have saved. Current complete history does not confirm it; inspect Notion and reconcile this exact operation. No duplicate comment was posted. After confirming absence in Notion, an operator can retry with retry_missing_note {confirmed_absent:true, reason}; that override is recorded.')
    card = await deps.reader.card(card.id, true)
    for (const [field, value] of Object.entries(state.original)) {
      if (input.kind === 'accept_review' && ['Waiting For', 'Sub-item'].includes(field)) continue
      const actual = card.properties[field]?.value ?? null
      if (!same(actual, value) && !(field in state.desired && same(actual, state.desired[field]))) throw new ReviewWriteError('review-card-changed', `${field} changed during review handoff; the newer card state was preserved`)
    }
    if (input.kind === 'accept_review') {
      const children = card.properties['Sub-item']
      let unfinished = !input.scope_complete || input.remaining_scope.length > 0 || !!String(card.properties['Waiting For']?.value ?? '').trim() || !!children?.hasMore
      for (const child of Array.isArray(children?.value) ? children.value : []) {
        const value = await deps.reader.card(String(child), true)
        if (!value.archived && !value.in_trash && !['Done', 'Archived'].includes(String(value.properties.Status?.value))) unfinished = true
      }
      const desired = { ...state.desired, ...(unfinished ? { Owner: 'Firstmate', Status: 'Queued' } : { Owner: 'Will', Status: 'Done' }) }
      const note = `${reviewResponsePrefix}${JSON.stringify({ submission_key: submissionKey, action: input.kind, accepted_by: 'Will', recorded_by: state.actor, feedback: input.feedback, remaining_scope: input.remaining_scope, next_status: desired.Status })}`
      state = { ...state, desired, note: `Date: ${new Date().toISOString()}\nBy: ${state.actor}\n${note}`,
        original: Object.fromEntries(Object.keys(state.original).map(field => [field, card!.properties[field]?.value ?? null])) }
      await deps.receipts.putReview(receiptKey, signature, card.id, state)
    }
    const missing = Object.fromEntries(Object.entries(state.desired).filter(([field, value]) => !same(card!.properties[field]?.value ?? null, value)).map(([field, value]) => [field, deps.property(card!, field, value)]))
    if (Object.keys(missing).length) {
      attempted = true
      const patched = await deps.content.patchProperties(card.id, missing)
      card = card.source?.provider === 'jira' ? patched as WorkCard : await deps.reader.card(card.id, true)
    }
    deps.reader.confirm(card)
    saved.push(...Object.keys(state.desired).filter(field => same(card!.properties[field]?.value ?? null, state!.desired[field])))
    if (saved.length !== Object.keys(state.desired).length) return result('partially-saved', 'review-readback-mismatch', 'Only listed properties are confirmed; reconcile current source before retrying')
    state = { ...state, note_pending: true }
    await deps.receipts.putReview(receiptKey, signature, card.id, state)
    attempted = true
    try { await deps.content.note(card.id, state.note, marker) }
    catch (error) {
      // A rejected request has no side effect. Network loss/5xx remains ambiguous.
      if (error instanceof NotionWriteError && error.status >= 400 && error.status < 500) await deps.receipts.putReview(receiptKey, signature, card.id, { ...state, note_pending: false })
      throw error
    }
    saved.push('note')
    await deps.receipts.putReview(receiptKey, signature, card.id, { ...state, done: true, note_pending: false })
    await deps.changed({ before, card, actor, operationId: input.operation_id, properties: state.desired, notes: [state.note] })
    return result('saved', 'review-saved', input.kind === 'submit_for_review' ? 'Review evidence and Owner/Status confirmed' : 'Explicit review response and resulting card status confirmed')
  } catch (error) {
    return result(attempted || state ? 'partially-saved' : 'not-saved', error instanceof ReviewWriteError ? error.code : 'review-source-unavailable',
      error instanceof ReviewWriteError ? error.message : 'Review write/readback is unconfirmed. Retry the same submission to reconcile source; no acceptance or notification is claimed.')
  }
}

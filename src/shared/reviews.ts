import { z } from 'zod'

import { reviewEvidenceSchema } from './reviewEvidence.mjs'
export { reviewEvidenceSchema, reviewSha } from './reviewEvidence.mjs'

const text = z.string().trim().min(1).max(4000)
const key = z.string().trim().min(1).max(128)
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>
export const reviewResponseSchema = z.object({ submission_key: key, feedback: text,
  // The caller attests remaining scope; current waits/child cards are checked too.
  remaining_scope: z.array(text).max(20), scope_complete: z.boolean().default(false),
}).strict()
export const reviewSubmissionPrefix = 'Tin Star review submission: '
export const reviewResponsePrefix = 'Tin Star review response: '
export const reviewIdentity = (cardId: string, evidence: Pick<ReviewEvidence, 'deliverable_id' | 'deployed_sha'>) => JSON.stringify([cardId, evidence.deliverable_id, evidence.deployed_sha])
export const legacyReviewKey = (id: string, revision: string) => `legacy:${id}:${revision}`
export const isReviewStatus = (value: unknown) => value === 'Ready for Review' || value === 'In review'
export function reviewSubmissions(notes: Array<{ text: string }>): ReviewEvidence[] {
  return notes.flatMap(note => note.text.split('\n').flatMap(line => {
    if (!line.startsWith(reviewSubmissionPrefix)) return []
    try { const parsed = reviewEvidenceSchema.safeParse(JSON.parse(line.slice(reviewSubmissionPrefix.length))); return parsed.success ? [parsed.data] : [] } catch { return [] }
  }))
}
export interface ReviewItem {
  id: string; cardId: string; submissionKey: string; title: string; status: string; cardUrl: string
  liveUrl: string | null; evidenceUrls: string[]; instructions: string | null
  linkedPulls?: string[]; submission: ReviewEvidence | null; evidenceWarning: string | null
}
export interface ReviewView {
  items: ReviewItem[]; complete: boolean; warning: string | null; observedAt: string | null
}
export interface ReviewQueueRead { reviews: ReviewView; warnings: string[] }

export function retainReviewEvidence(next: ReviewQueueRead, previous: ReviewQueueRead | null): ReviewQueueRead {
  return { ...next, reviews: { ...next.reviews, items: next.reviews.items.map(item => {
    const known = previous?.reviews.items.find(old => old.cardId === item.cardId)
    return !item.submission && known?.submission ? { ...item, submissionKey: known.submissionKey, submission: known.submission } : item
  }) } }
}
export function separatePullReview(prUrl: string | null | undefined, status: string | null | undefined, reviews: ReviewView): boolean {
  return status === 'open' || !reviews.items.some(item => item.linkedPulls?.some(url => url === prUrl) || item.submission?.pulls.some(pull => pull.url === prUrl))
}

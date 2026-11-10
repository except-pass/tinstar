import { z } from 'zod'

const text = z.string().trim().min(1).max(4000)
const key = z.string().trim().min(1).max(128)
const url = z.string().url().max(2048).refine(value => {
  const parsed = new URL(value)
  return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
}, 'Use an HTTP evidence link without credentials')
export const reviewSha = z.string().regex(/^[a-f0-9]{40}$/)
export const reviewEvidenceSchema = z.object({
  submission_key: key, deliverable_id: key, summary: text,
  pulls: z.array(z.object({ url: url.refine(value => /^https:\/\/github.com\/except-pass\/tinstar\/pull\/[1-9]\d*$/.test(value), 'Use a canonical Tin Star PR URL'), head: reviewSha }).strict()).min(1).max(20),
  deployment_id: key, deployed_sha: reviewSha, live_url: url, instructions: text,
  proof: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ui'), tested_sha: reviewSha, passed: z.literal(true), receipt: url, screenshots: z.array(url).min(1).max(10) }).strict(),
    z.object({ kind: z.literal('non-ui'), tested_sha: reviewSha, passed: z.literal(true), receipt: url, alternative: text }).strict(),
  ]),
  remaining_scope: z.array(text).max(20),
}).strict()
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
  submission: ReviewEvidence | null; evidenceWarning: string | null
}
export interface ReviewView {
  items: ReviewItem[]; complete: boolean; warning: string | null; observedAt: string | null
}

// Shared with the plain-Node guarded deployment CLI.
import { z } from 'zod'

const text = z.string().trim().min(1).max(4000)
const key = z.string().trim().min(1).max(128)
const url = z.string().url().max(2048).refine(value => {
  try {
    const parsed = new URL(value)
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
  } catch { return false }
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

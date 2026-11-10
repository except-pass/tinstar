import { z } from 'zod'
import { askActionSchema } from './ask-actions'

export const decisionReferenceSchema = z.object({ label: z.string().min(1).max(512), url: z.string().url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password
}) }).strict()
/** Published advisory data. Membership and freshness are resolved again by the
 * existing authenticated Ask selection route before any instruction is sent. */
export const decisionProposalSchema = z.object({
  schema: z.literal('tinstar.decision-proposal.v1'),
  proposal_id: z.string().min(1).max(256), request_key: z.string().min(1).max(4096),
  card_id: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  question: z.string().trim().min(1).max(2000), rationale: z.string().trim().min(1).max(4000),
  recommended_action_id: z.string().min(1).max(64), actions: z.array(askActionSchema).min(1).max(10),
  references: z.array(decisionReferenceSchema).max(20),
  source: z.object({ kind: z.enum(['firstmate-request', 'ask-reply']), id: z.string().min(1).max(2048), revision: z.string().min(1).max(2048) }).strict(),
  published_at: z.string().datetime({ offset: true }), supersedes: z.string().min(1).max(256).nullable(),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.actions.map(action => action.id)).size !== value.actions.length) ctx.addIssue({ code: 'custom', path: ['actions'], message: 'Action IDs must be unique' })
  if (!value.actions.some(action => action.id === value.recommended_action_id)) ctx.addIssue({ code: 'custom', path: ['recommended_action_id'], message: 'Recommendation must identify a published action' })
})
export type DecisionProposal = z.infer<typeof decisionProposalSchema>

/** Match source meaning across refreshes, independent of collector ordering. */
export const decisionRequestRevision = (item: Pick<import('../server/reconciliation/queue').QueueItem, 'id' | 'action' | 'cardIds' | 'sources'>) => JSON.stringify([
  item.id, item.action, [...item.cardIds].sort(),
  // GitHub observations are checked by the existing action path, not part of
  // the original First Mate/Notion request identity used by ordinary questions.
  item.sources.filter(source => source.kind !== 'github').map(source => JSON.stringify([source.id, source.request, source.question ?? source.action, source.generation])).sort(),
])

export function currentDecisionProposal<T extends { answer_id: string; value: DecisionProposal }>(candidates: T[]): T | undefined {
  return candidates.filter(candidate => !candidates.some(other => other !== candidate && other.value.supersedes === candidate.value.proposal_id))
    .sort((a, b) => Date.parse(a.value.published_at) - Date.parse(b.value.published_at)).at(-1)
}

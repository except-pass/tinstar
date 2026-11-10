import { z } from 'zod'
import { firstMateRequestSchema, requestAnchor } from './deskSource'
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

export function currentDecisionProposal<T extends { value: unknown; source_request?: unknown }>(candidates: T[]): T | undefined {
  const parsed = candidates.flatMap(candidate => {
    const value = decisionProposalSchema.safeParse(candidate.value)
    return value.success ? [{ candidate, value: value.data }] : []
  })
  if (!parsed.length || new Set(parsed.map(entry => entry.value.request_key)).size !== 1) return undefined
  const bindings = parsed.filter(entry => entry.candidate.source_request !== undefined).map(entry => firstMateRequestSchema.safeParse(entry.candidate.source_request))
  if (bindings.some(binding => !binding.success) || new Set(bindings.flatMap(binding => binding.success ? [requestAnchor(binding.data)] : [])).size > 1) return undefined
  const publications = new Map<string, typeof parsed[number]>()
  for (const entry of parsed) {
    const prior = publications.get(entry.value.proposal_id)
    if (prior && JSON.stringify(prior.value) !== JSON.stringify(entry.value)) return undefined
    publications.set(entry.value.proposal_id, entry)
  }
  const replaced = new Set(parsed.map(entry => entry.value.supersedes))
  const heads = [...publications.values()].filter(entry => !replaced.has(entry.value.proposal_id))
  if (heads.length !== 1) return undefined
  const visited = new Set<string>()
  let entry: typeof parsed[number] | undefined = heads[0]
  while (entry) {
    if (visited.has(entry.value.proposal_id)) return undefined
    visited.add(entry.value.proposal_id)
    entry = entry.value.supersedes ? publications.get(entry.value.supersedes) : undefined
  }
  return visited.size === publications.size ? heads[0]!.candidate : undefined
}

export function decisionFresh(item: import('../server/reconciliation/queue').QueueItem, now = Date.now()) {
  return item.readiness === 'ready-now' && item.sources.length > 0 && item.sources.every(source =>
    ['fresh', 'partial'].includes(source.status) && source.coverage === 'complete' && !!source.observedAt &&
    !!source.expiresAt && Date.parse(source.expiresAt) > now)
}

export function decisionProposalReady(item: import('../server/reconciliation/queue').QueueItem | undefined, proposal: { answer_id: string; value: DecisionProposal } | undefined, answer: Pick<import('./ask').AskItem, 'context'> | undefined, now: number) {
  if (!item || !proposal || !decisionFresh(item, now) || proposal.value.request_key !== item.id || proposal.value.card_id && !item.cardIds.includes(proposal.value.card_id)) return false
  if (proposal.value.source.kind === 'ask-reply') return proposal.value.source.id === proposal.answer_id && answer?.context.target?.kind === 'decision' && answer.context.target.id === item.id && answer.context.decision?.revision === decisionRequestRevision(item)
  return item.proposal?.answer_id === proposal.answer_id && JSON.stringify(item.proposal.value) === JSON.stringify(proposal.value)
}

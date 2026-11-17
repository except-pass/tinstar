import { z } from 'zod'
import { firstMateRequestSchema } from './deskSource'
import { cardIdSchema } from './workIdentity'
import { decisionOptionsSchema } from './workflow'
import { decisionReferenceSchema } from './decisionProposal'

const prose = z.string().trim().min(1).max(12000)
export const decisionDependencyKind = z.enum(['request', 'card', 'answer', 'pr-head', 'worker', 'release', 'evidence'])
export const decisionDependencySchema = z.object({ kind: decisionDependencyKind, key: z.string().min(1).max(4096), revision: z.string().min(1).max(32000) }).strict()
export type DecisionDependency = z.infer<typeof decisionDependencySchema>
export interface DecisionDependencyObservation {
  kind: DecisionDependency['kind']; key: string; revision: string | null
  status: 'fresh' | 'partial' | 'stale' | 'unknown'
  coverage: 'complete' | 'partial' | 'unknown'
  observed_at: string | null; expires_at: string | null
  /** Last complete source observation retained during a bounded renewal. */
  renewal_until?: string | null
}
export const decisionPacketBindingSchema = z.object({
  // Card-native requests bind to their card history record instead of a fleet request.
  card_id: cardIdSchema, request_key: z.string().min(1).max(4096), source_request: firstMateRequestSchema.nullable(),
  request_id: z.string().min(1).max(128), source_id: z.string().min(1).max(1024),
  source_question: prose, source_spawn_gen: z.string().nullable(), source_revision: z.string().min(1).max(64000),
  options: decisionOptionsSchema,
}).strict()
export type DecisionPacketBinding = z.infer<typeof decisionPacketBindingSchema>

/** One existing source request only. Multipart grouping is deliberately deferred
 * until its authoritative source contract is chosen; preparation creates no asks. */
export const decisionPacketSchema = z.object({
  schema: z.literal('tinstar.decision-packet.v1'), binding: decisionPacketBindingSchema,
  title: prose, question: prose, background: prose, rationale: prose,
  recommended_option_id: z.string().min(1).max(128),
  risk: z.object({ rating: z.enum(['Low', 'Medium', 'High']), likelihood: prose, explanation: prose, blast_radius: prose }).strict(),
  reversibility: z.object({ rating: z.enum(['Easy', 'Moderate', 'Difficult']), explanation: prose, rollback: prose, residual_exposure: prose }).strict(),
  confidence: z.enum(['High', 'Medium', 'Low']), uncertainty: z.array(prose).max(30), material_unknowns: z.array(prose).max(30),
  consequences: z.array(prose).max(30), impacted: z.array(prose).max(30), prerequisites: z.array(prose).max(30),
  authorization: z.object({ scope: prose, next_owner: prose, next_status: z.enum(['Queued', 'Todo', 'Backlog', 'Waiting For']), permitted_follow_up: prose, remaining_gates: z.array(prose).max(30) }).strict(),
  references: z.array(decisionReferenceSchema).min(1).max(30), dependencies: z.array(decisionDependencySchema).min(1).max(100),
  invalidation_conditions: z.array(prose).min(1).max(30), review_within_ms: z.number().int().positive(),
}).strict().superRefine((packet, ctx) => {
  if (!packet.binding.options.some(option => option.id === packet.recommended_option_id)) ctx.addIssue({ code: 'custom', path: ['recommended_option_id'], message: 'Recommendation must name an existing source option' })
  const keys = packet.dependencies.map(dependency => JSON.stringify([dependency.kind, dependency.key]))
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['dependencies'], message: 'Dependency identities must be unique' })
})
export type DecisionPacket = z.infer<typeof decisionPacketSchema>
export const decisionPolicyValuesSchema = z.object({ target_ready: z.number().int().min(1).max(30), max_preparers: z.number().int().min(1).max(8), automatic_replenishment: z.boolean() }).strict()
export const decisionPolicyUpdateSchema = z.object({ expected_version: z.number().int().nonnegative(), values: decisionPolicyValuesSchema }).strict()
/** Replenishment stays off until Preparation saves it on. That visible control is
 * the only switch, so a deploy does not post jobs before the owner turns it on. */
export const defaultDecisionPolicy = { target_ready: 10, max_preparers: 3, automatic_replenishment: false } as const

/** Canonicalize object/set ordering and line endings, not timestamps or text
 * meaning. Call sites explicitly choose which fields are semantic. */
export function decisionMeaning(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (typeof input === 'string') return input.replace(/\r\n?/g, '\n')
    if (Array.isArray(input)) return input.map(normalize)
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, normalize(v)]))
    return input
  }
  return JSON.stringify(normalize(value))
}
export const dependencyIdentity = (value: Pick<DecisionDependency, 'kind' | 'key'>) => JSON.stringify([value.kind, value.key])
export const bindingMeaning = (binding: DecisionPacketBinding) => decisionMeaning({ ...binding, options: [...binding.options].sort((a, b) => a.id.localeCompare(b.id)) })

export interface DecisionRequestEvidence {
  binding: DecisionPacketBinding | null; question: string | null
  dependencies: DecisionDependencyObservation[]; reasons: string[]; answered: boolean
}
export interface DecisionEvidence {
  deferred?: boolean
  card_id: string; requests: DecisionRequestEvidence[]; reasons: string[]
  omissions: string[]; observed_at: string | null
}
export interface DecisionPacketValidation { valid: boolean; reasons: string[]; valid_until: string | null }

/** A pure admission check, shared by publication and later claim/submit work.
 * Missing evidence must not authorize a different option or stale request. */
export function validateDecisionPacket(packet: DecisionPacket, evidence: DecisionEvidence, now: number): DecisionPacketValidation {
  const reasons = [...evidence.reasons]
  for (const unknown of packet.material_unknowns) reasons.push(`Material evidence is unknown: ${unknown}`)
  if (evidence.card_id !== packet.binding.card_id) reasons.push('Canonical card differs from the packet')
  const candidates = evidence.requests.filter(request => request.binding?.request_id === packet.binding.request_id)
  const source = candidates.length === 1 ? candidates[0] : undefined
  let validUntil = Infinity
  if (!source?.binding) reasons.push('Exact source request and supported options are unavailable or ambiguous')
  else {
    reasons.push(...source.reasons)
    if (bindingMeaning(source.binding) !== bindingMeaning(packet.binding)) reasons.push('Source request, revision or exact options changed')
    if (source.question !== packet.question) reasons.push('Packet question differs from the exact source question')
    if (source.answered) reasons.push('This source request already has an answer')
    const current = new Map(source.dependencies.map(dependency => [dependencyIdentity(dependency), dependency]))
    const declared = new Map(packet.dependencies.map(dependency => [dependencyIdentity(dependency), dependency]))
    for (const key of new Set([...current.keys(), ...declared.keys()])) {
      const actual = current.get(key), expected = declared.get(key)
      if (!actual || !expected || !actual.revision || actual.revision !== expected.revision) reasons.push(`Dependency changed or missing: ${key}`)
      const until = actual && Math.max(Date.parse(actual.expires_at ?? ''), Date.parse(actual.renewal_until ?? actual.expires_at ?? ''))
      if (!actual || actual.status !== 'fresh' || actual.coverage !== 'complete' || !actual.observed_at || !Number.isFinite(Date.parse(actual.observed_at)) || Date.parse(actual.observed_at) > now || !until || !Number.isFinite(until) || until <= now) reasons.push(`Evidence is stale, partial or unavailable: ${key}`)
      else validUntil = Math.min(validUntil, until)
    }
  }
  const unique = [...new Set(reasons)]
  return { valid: unique.length === 0, reasons: unique, valid_until: unique.length || !Number.isFinite(validUntil) ? null : new Date(validUntil).toISOString() }
}

/** Current source evidence and leases determine readiness. Packet age does not
 * expire unchanged research; an old validation alone cannot authorize review. */
export function decisionPacketReady(validation: DecisionPacketValidation | null, leased: boolean, now: number) {
  const reasons = [...(validation?.reasons ?? ['Packet has not been validated'])]
  if (!validation?.valid && !reasons.length) reasons.push('Packet validation failed')
  if (!validation?.valid_until || Date.parse(validation.valid_until) <= now || !Number.isFinite(Date.parse(validation.valid_until))) reasons.push('Evidence validation expired or unavailable')
  if (leased) reasons.push('Canonical card is leased to a reviewer')
  return { ready: reasons.length === 0, reasons: [...new Set(reasons)] }
}

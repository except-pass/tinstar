import { z } from 'zod'
const identity = z.string().min(1).max(1024).refine(value => value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value), 'Use an exact nonempty identity')
export const cardIdSchema = z.string().regex(/^[a-f0-9]{32}$/)
export const workerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('firstmate'), fm_home: identity, task_id: identity, first_observed_spawn_gen: identity }).strict(),
  z.object({ kind: z.literal('external'), system: identity, run_id: identity, reference: z.string().url().max(2048).refine(value => /^https?:/.test(value), 'Use an HTTP run reference'),
    card_id: cardIdSchema, observed_at: z.string().datetime({ offset: true }), state: z.literal('running'), evidence: z.string().min(12).max(2000) }).strict(),
])
export const startWorkSchema = z.object({ card_id: cardIdSchema, operation_id: z.string().min(1).max(128), worker: workerSchema,
  expected: z.object({ owner: z.string().nullable(), status: z.string().nullable(), worker_links: z.string().nullable() }).strict().optional(),
}).strict()
export type StartWorkInput = z.infer<typeof startWorkSchema>
export const searchWorkSchema = z.object({ owner: z.string().min(1).max(200).optional(), statuses: z.array(z.string().min(1).max(100)).min(1).max(30).optional(),
  initiative: z.string().min(1).max(200).optional(), epic: z.string().min(1).max(200).optional(), checkpoint_before: z.string().datetime({ offset: true }).optional(),
  history: z.boolean().default(false), query: z.string().max(500).default(''), patterns: z.array(z.enum(['active', 'blocked', 'decision', 'stalled', 'unstaffed', 'mismatch', 'stale', 'idle'])).max(8).default([]),
  offset: z.number().int().min(0).max(2000).default(0), limit: z.number().int().min(1).max(100).default(50), refresh: z.boolean().default(false),
}).strict()
export type SearchWorkInput = z.infer<typeof searchWorkSchema>
export const getWorkSchema = z.object({ card_id: cardIdSchema, details: z.boolean().default(true), refresh: z.boolean().default(false) }).strict()
// Ordinary properties are explicit; policy fields have operations so neither
// the Inspector nor MCP can bypass coupled transitions through a raw editor.
const prose = z.string().trim().min(1).max(12000)
const label = z.string().trim().min(1).max(200)
export const ordinaryPropertiesSchema = z.object({
  Name: label.optional(), Area: label.optional(), Priority: label.nullable().optional(),
  'Sub-area': label.nullable().optional(), Attention: label.nullable().optional(),
  Initiative: z.union([label, z.array(cardIdSchema).max(100)]).nullable().optional(),
  Epic: z.union([label, z.array(cardIdSchema).max(100)]).nullable().optional(),
  Link: z.string().url().max(2048).nullable().optional(),
  'Due Date': z.string().max(100).nullable().optional(), 'Start Date': z.string().max(100).nullable().optional(),
  'Next action': prose.optional(),
}).strict()
const contentSchema = z.object({ brief: prose.optional(), acceptance_criteria: prose.optional() }).strict()
const base = { card_id: cardIdSchema, operation_id: z.string().min(1).max(128),
  expected: z.record(z.unknown()).optional() }
const next = { owner: label, status: z.enum(['Queued', 'Todo', 'Backlog', 'In Progress', 'Waiting For', 'Done', 'Archived']),
  worker: workerSchema.optional(), disposition: prose.optional(), evidence: prose.optional(),
  wait: z.object({ dependency: prose, unblocks_when: prose, follow_up_by: label }).strict().optional() }
const checkpointSchema = z.object({ assessment: prose, evidence: prose, next_action: prose,
  next_check_in: z.string().min(1).max(100), confirmation: z.enum(['provisional', 'owner-confirmed']),
  request_id: z.string().uuid().optional(), blocker: prose.optional() }).strict()
export const updateWorkSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('edit'), properties: ordinaryPropertiesSchema.optional(), content: contentSchema.optional(), note: prose.optional() }).strict(),
  z.object({ ...base, kind: z.literal('assign'), owner: label, status: z.enum(['Queued', 'Todo', 'Backlog']).default('Queued'), note: prose.optional() }).strict(),
  z.object({ ...base, kind: z.literal('checkpoint'), checkpoint: checkpointSchema }).strict(),
  z.object({ ...base, kind: z.literal('wait'), dependency: prose, unblocks_when: prose, follow_up_by: label, note: prose.optional() }).strict(),
  z.object({ ...base, kind: z.literal('request_decision'), request_id: z.string().min(1).max(128), question: prose,
    action: label.default('Decision'), requested_from: label }).strict(),
  z.object({ ...base, kind: z.literal('answer_decision'), request_id: z.string().min(1).max(128), answer: prose,
    next: z.object(next).strict(), resolve_wait: prose.optional(), legacy_action: label.optional() }).strict(),
  z.object({ ...base, kind: z.literal('complete'), disposition: prose, evidence: prose }).strict(),
  z.object({ ...base, kind: z.literal('park'), disposition: prose, status: z.enum(['Backlog', 'Archived']).default('Backlog') }).strict(),
])
export type UpdateWorkInput = z.infer<typeof updateWorkSchema>
export const createWorkSchema = z.object({ operation_id: z.string().min(1).max(128), name: label, owner: label, area: label,
  status: z.enum(['Queued', 'Todo', 'Backlog']).default('Queued'),
  properties: ordinaryPropertiesSchema.omit({ Name: true, Area: true }).optional(), content: contentSchema.optional(),
}).strict()
export type CreateWorkInput = z.infer<typeof createWorkSchema>
export const workflowRules = {
  version: 'tinstar.workflow.s3', enforced: [
    'Create requires a declared Owner, Status and Area. Assignment to Firstmate is Queued until real execution.',
    'Start work requires Owner and Area and current tracked execution evidence.',
    'First Mate workers retain exact home, task and spawn-generation identities. External runs retain their system, run reference, card and authenticated reporter; their evidence is consumer-reported, not independently verified.',
    'Unknown, stale or historical worker evidence does not authorize a new start. Existing cards are never silently repaired; unrelated notes/corrections remain possible.',
    'Waiting For requires a dependency, what unblocks it and who follows up.',
    'A decision answer names the next Owner/Status and clears only that request. Other asks, waits and worker history survive.',
    'Completion/parking requires a caller-supported disposition; a merge or worker exit never implies business completion.',
    'Next check-in uses America/New_York, date-only means 9 AM. Checkpoints require assessment, evidence, next action and provisional/owner-confirmed attribution. In Progress appointments obey the board ceiling. Ordinary activity never advances them.',
    'Notion is authoritative. Unconfirmed writes report not-saved or partially-saved; Only a missing note may be repaired in the same process while the card remains unchanged after a confirmed property write. Otherwise review current state and re-issue with a new operation_id; no automatic replay or restart recovery.',
    'UI and MCP use the same serialized operations and authenticated actor. Firstmate pickup is Queued only; active edits are contextual updates, never worker dispatch.',
  ],
  operations: {
    read: ['search_work: current assigned cards, independent of UI filters; history is explicit', 'get_work: exact card, properties/worker evidence and optional bounded body/comments', 'get_work_views: shared Needs Will/PR evidence and advisory execution warnings; no window required'],
    write: ['create_work: operation_id, name, owner, area, optional ordinary properties and content {brief,acceptance_criteria}', 'start_work: card_id, operation_id, worker (firstmate exact home/task/spawn generation, or external system/run_id/reference/card_id/observed_at/state/evidence)', 'update_work: card_id, operation_id, kind (edit,assign,checkpoint,wait,request_decision,answer_decision,complete,park); use tool schema for coupled fields'],
    decisions: 'request_decision records request_id, question, requested_from and action. answer_decision requires that request_id, answer and next {owner,status}; In Progress also requires worker, Waiting For requires wait, Done/Archived requires disposition/evidence. legacy_action and resolve_wait clear only explicitly identified legacy asks/waits.',
    checkpoints: 'checkpoint requires assessment, evidence, next_action, next_check_in, confirmation (provisional or owner-confirmed); include the original watchdog request_id when responding, and blocker when applicable. Business days 8 AM–8 PM Eastern: at most four hours; otherwise no later than 10 AM next business morning. Date-only is 9 AM Eastern; Due Date is a separate delivery deadline.',
    repair: 'Retry identical operation_id and intent after an uncertain response. A definite result with requires_new_operation_id means refresh and explicitly re-issue. Only a missing history note can be repaired in-process while its confirmed card state is unchanged; no automatic replay.',
  },
  views: ['Needs Will requires a current explicit ask; green PRs alone do not create merge permission. Request age is unknown unless request history supplies a timestamp; PR creation is labelled separately.', 'In Progress warnings inspect linked sources with their existing freshness windows. Stale or missing evidence is unknown, never stranded. Warnings do not mutate or block existing cards.'],
  retained_dependencies: ['First Mate owns worker dispatch/supervision and its inbox. Tin Star owns pickup/update notices and the mechanical check-in watchdog.', 'The Mac poller and duplicate PM Bot monitors are retired by their owners only after guarded live feed validation. No paused routine is restarted; PM Bot reasoning/reporting remains.'],
}
export interface StartWorkResult {
  outcome: 'saved' | 'not-saved' | 'partially-saved'
  code: string
  message: string
  operation_id: string
  saved_fields: string[]
  requires_new_operation_id?: boolean
  card?: unknown
}

/** External runs are deliberately separate from native FM identities/claims.
 * A recent report is attribution, not independent runtime verification. */
export function externalWorkers(value: unknown, now = Date.now()) {
  if (typeof value !== 'string') return []
  return value.split('\n').flatMap(line => {
    try {
      const row = JSON.parse(line)
      if (row.schema !== 'tinstar.external-worker.v1' || typeof row.reported_by !== 'string') return []
      const { schema: _schema, reported_by, ...input } = row
      const parsed = workerSchema.safeParse(input)
      if (!parsed.success || parsed.data.kind !== 'external') return []
      const age = now - Date.parse(parsed.data.observed_at)
      return [{ ...parsed.data, reported_by, verification: 'consumer-reported' as const,
        freshness: age >= -30_000 && age < 300_000 ? 'current-report' as const : 'unknown' as const }]
    } catch { return [] }
  })
}

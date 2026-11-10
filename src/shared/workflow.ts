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
export const workflowRules = {
  version: 'tinstar.workflow.s1', enforced: ['Start work requires Owner and Area and current tracked execution evidence.',
    'First Mate workers retain exact home, task and spawn-generation identities. External runs retain their system, run reference, card and authenticated reporter; their evidence is consumer-reported, not independently verified.',
    'Unknown, stale or historical worker evidence does not authorize a new start. Existing cards are never silently repaired.',
    'Start writes worker provenance, In Progress and Last touched by together; it preserves checkpoints, waits and asks.',
    'Notion is authoritative. Unconfirmed writes report not-saved or partially-saved; retry the same operation_id with identical input.',
    'Next check-in uses America/New_York, date-only means 9 AM, and ordinary activity never advances it.'],
  later_slices: ['Create/edit/assign, checkpoints, waits, decisions, completion/parking', 'First Mate pickup/update and watchdog write migration', 'Computed decision view and redundant writer/poller retirement'],
}
export interface StartWorkResult {
  outcome: 'saved' | 'not-saved' | 'partially-saved'
  code: string
  message: string
  operation_id: string
  saved_fields: string[]
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

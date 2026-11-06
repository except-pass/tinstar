import { z } from 'zod'
import type { PresentationAction, PresentationState } from './reconciliationPresentation'
import { patterns } from './workHealth'

export const searchFilterSchema = z.object({ query: z.string().max(512), patterns: z.array(z.enum([patterns[0]!, ...patterns.slice(1)])).max(8), facets: z.array(z.object({ field: z.enum(['initiative', 'machine', 'manager', 'entity']), value: z.string().min(1).max(2048) }).strict()).max(32) }).strict()

export const fieldSchema = z.enum(['manager', 'machine', 'workerStatus', 'activity', 'initiative', 'epic', 'status', 'owner', 'priority', 'checkIn', 'due', 'edited', 'area', 'subArea'])
export const organizerSchema = z.object({ outer: z.union([fieldSchema, z.literal('none')]), inner: z.union([fieldSchema, z.literal('none')]), order: z.union([fieldSchema, z.literal('operational')]), direction: z.enum(['asc', 'desc']) }).strict()
export const statusFilterSchema = z.object({ preset: z.enum(['operational', 'all', 'custom']), statuses: z.array(z.string().max(256)).max(256) }).strict()

export const donutFilterSchema = z.object({ cards: z.array(z.string().max(256)).max(256), workers: z.array(z.string().max(256)).max(256) }).strict()

export const targetSchema = z.object({ kind: z.enum(['card', 'execution', 'claim', 'manager', 'group', 'you', 'firstMate']), id: z.string().min(1).max(2048) }).strict()
const searchViewSchema = z.object({
  search: searchFilterSchema.optional(),
  selection: targetSchema.nullable(), collapsed: z.array(z.string().max(2048)).max(4096),
  navigation: z.object({ cardId: z.string().min(1).max(64), revision: z.number().int().nonnegative() }).nullable().optional(),
  exceptionsOnly: z.boolean(), roadmapExpanded: z.boolean(), organizer: organizerSchema.optional(), statusFilter: statusFilterSchema.optional(),
  donutFilter: donutFilterSchema.optional(), linksVisible: z.boolean().optional(), arrangement: z.enum(['initiative', 'secondMate', 'machine']), sort: z.enum(['activity', 'priority']).optional(),
}).strict()
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set-search'), search: searchFilterSchema }).strict(),
  z.object({ type: z.literal('clear-search') }).strict(),
  z.object({ type: z.literal('reveal-search'), target: targetSchema.refine(target => ['card', 'execution'].includes(target.kind)) }).strict(),
  z.object({ type: z.literal('restore-search-view'), view: searchViewSchema }).strict(),
  z.object({ type: z.literal('set-organizer'), organizer: organizerSchema }).strict(),
  z.object({ type: z.literal('set-status-filter'), filter: statusFilterSchema }).strict(),
  z.object({ type: z.literal('set-donut-filter'), filter: donutFilterSchema }).strict(),
  z.object({ type: z.literal('clear-donut-filter') }).strict(),
  z.object({ type: z.literal('reset-floor') }).strict(),
  z.object({ type: z.literal('set-sort'), sort: z.enum(['activity', 'priority']) }).strict(),
  z.object({ type: z.literal('set-links'), visible: z.boolean() }).strict(),
  z.object({ type: z.literal('set-arrangement'), arrangement: z.enum(['initiative', 'secondMate', 'machine']) }).strict(),
  z.object({ type: z.literal('set-expanded'), target: targetSchema.refine(t => ['manager', 'group'].includes(t.kind)), expanded: z.boolean() }).strict(),
  z.object({ type: z.literal('navigate-card'), cardId: z.string().min(1).max(64) }).strict(),
  z.object({ type: z.literal('focus'), target: targetSchema }).strict(),
  z.object({ type: z.literal('set-exceptions'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('set-roadmap'), expanded: z.boolean() }).strict(),
  z.object({ type: z.literal('flash'), targets: z.array(targetSchema).min(1).max(100), durationMs: z.number().int().min(0).max(4000).optional() }).strict(),
  z.object({ type: z.literal('open-queue'), cardId: z.string().min(1).max(64).optional(), itemId: z.string().min(1).max(4096).optional() }).strict(),
  z.object({ type: z.literal('navigate-queue'), direction: z.enum(['next', 'previous']) }).strict(),
  z.object({ type: z.literal('close-queue') }).strict(),
  z.object({ type: z.literal('clear-transient') }).strict(),
  z.object({ type: z.literal('clear-selection') }).strict(),
])
export const stateSchema = z.object({
  search: searchFilterSchema.optional(), searchReveal: targetSchema.nullable().optional(),
  navigation: z.object({ cardId: z.string().min(1).max(64), revision: z.number().int().nonnegative() }).nullable().optional(),
  donutFilter: donutFilterSchema.optional(), organizer: organizerSchema.optional(), statusFilter: statusFilterSchema.optional(),
  sort: z.enum(['activity', 'priority']).optional(), linksVisible: z.boolean().optional(),
  revision: z.number().int().nonnegative(), arrangement: z.enum(['initiative', 'secondMate', 'machine']), selection: targetSchema.nullable(),
  collapsed: z.array(z.string().max(2048)).max(4096), exceptionsOnly: z.boolean(), roadmapExpanded: z.boolean(),
  flash: z.object({ ids: z.array(z.string().max(2048)).max(4096), until: z.number() }).nullable(), assistantChangedView: z.boolean(),
  queueOpen: z.boolean().optional(), queueCardId: z.string().nullable().optional(), queueItemId: z.string().max(4096).nullable().optional(),
}).strict()
export type CommandOutcome = 'queued' | 'applied' | 'expired' | 'disconnected' | 'unknown-id' | 'unauthorized' | 'stale-revision' | 'conflict' | 'queue-source-unavailable'
export interface ViewCommand {
  command_id: string
  scene_id: string
  action: PresentationAction
  expected_revision: number
  expires_at: number
}
export interface CommandResult {
  command_id: string
  scene_id: string
  outcome: CommandOutcome
  revision?: number
  applied_at?: number
  state?: PresentationState
}

import { z } from 'zod'
import type { PresentationAction, PresentationState } from './reconciliationPresentation'

export const targetSchema = z.object({ kind: z.enum(['card', 'execution', 'claim', 'manager', 'group', 'you', 'firstMate']), id: z.string().min(1).max(2048) }).strict()
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set-arrangement'), arrangement: z.enum(['initiative', 'secondMate', 'machine']) }).strict(),
  z.object({ type: z.literal('set-expanded'), target: targetSchema.refine(t => ['manager', 'group'].includes(t.kind)), expanded: z.boolean() }).strict(),
  z.object({ type: z.literal('focus'), target: targetSchema }).strict(),
  z.object({ type: z.literal('set-exceptions'), enabled: z.boolean() }).strict(),
  z.object({ type: z.literal('set-roadmap'), expanded: z.boolean() }).strict(),
  z.object({ type: z.literal('flash'), targets: z.array(targetSchema).min(1).max(100), durationMs: z.number().int().min(0).max(4000).optional() }).strict(),
  z.object({ type: z.literal('open-queue'), cardId: z.string().min(1).max(64).optional() }).strict(),
  z.object({ type: z.literal('close-queue') }).strict(),
  z.object({ type: z.literal('clear-transient') }).strict(),
  z.object({ type: z.literal('clear-selection') }).strict(),
])
export const stateSchema = z.object({
  revision: z.number().int().nonnegative(), arrangement: z.enum(['initiative', 'secondMate', 'machine']), selection: targetSchema.nullable(),
  collapsed: z.array(z.string().max(2048)).max(4096), exceptionsOnly: z.boolean(), roadmapExpanded: z.boolean(),
  flash: z.object({ ids: z.array(z.string().max(2048)).max(100), until: z.number() }).nullable(), assistantChangedView: z.boolean(),
  queueOpen: z.boolean().optional(), queueCardId: z.string().nullable().optional(),
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
  state?: PresentationState
}

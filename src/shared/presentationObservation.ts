import { z } from 'zod'
import type { PresentationAction, PresentationState, Target } from './reconciliationPresentation'
import type { DeskQueue } from './reconciliationQueue'
import { isCoordinationRequest } from './requestText'

export const semanticIdSchema = z.string().max(2060)

/** Source generation, React commit, and browser visibility are separate facts. */
export const renderedObservationSchema = z.object({
  scene_generated_at: z.string().datetime().nullable(), scene_read_failed: z.boolean(),
  rendered_at: z.string().datetime().nullable().optional(), revision: z.number().int().nonnegative().optional(),
  surface: z.enum(['overview', 'decisions', 'other']).optional(),
  route: z.string().max(2048).optional(), title: z.string().max(256).optional(),
  visibility: z.enum(['visible', 'hidden']).optional(), focused: z.boolean().optional(),
  selection: semanticIdSchema.nullable().optional(), pending_command: z.string().max(128).nullable().optional(),
}).strict()
export type RenderedObservation = z.infer<typeof renderedObservationSchema>
export const deliverySchema = z.object({
  stage: z.enum(['accepted', 'applied-to-state', 'rendered', 'foreground-visible', 'not-visible', 'not-supported']),
  reason: z.string().max(256).optional(), observed_at: z.string().datetime().optional(),
  surface: z.enum(['overview', 'decisions', 'other']).optional(), route: z.string().max(2048).optional(),
  targets: z.array(semanticIdSchema).max(4097).optional(),
  rendered_targets: z.array(semanticIdSchema).max(4097).optional(),
  visible_targets: z.array(semanticIdSchema).max(4097).optional(), pending: z.boolean().optional(),
}).strict()
export type PresentationDelivery = z.infer<typeof deliverySchema>
export function presentationTargets(action: PresentationAction, state?: PresentationState, queue?: DeskQueue | null): Target[] {
  if (action.type === 'open-queue' || action.type === 'navigate-queue') {
    const entries = (queue?.needsWill ?? queue?.items ?? []).filter(item => !isCoordinationRequest(item.title))
    const item = state?.queueCardId ? entries.find(item => item.cardIds.includes(state.queueCardId!)) : entries.find(item => item.id === state?.queueItemId)
    return item?.cardIds[0] ? [{ kind: 'card', id: item.cardIds[0] }] : []
  }
  if (action.type === 'navigate-card') return [{ kind: 'card', id: action.cardId }]
  if (action.type === 'reveal-search') return [...new Map([action.target, ...(action.targets ?? [])].map(target => [`${target.kind}:${target.id}`, target])).values()]
  if (action.type === 'focus') return [action.target]
  return action.type === 'flash' ? [...new Map(action.targets.map(target => [`${target.kind}:${target.id}`, target])).values()] : []
}

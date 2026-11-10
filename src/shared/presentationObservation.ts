import { z } from 'zod'
import type { PresentationAction, Target } from './reconciliationPresentation'

/** Source generation, React commit, and browser visibility are separate facts. */
export const renderedObservationSchema = z.object({
  scene_generated_at: z.string().datetime().nullable(), scene_read_failed: z.boolean(),
  rendered_at: z.string().datetime().nullable().optional(), revision: z.number().int().nonnegative().optional(),
  surface: z.enum(['overview', 'decisions', 'other']).optional(),
  route: z.string().max(2048).optional(), title: z.string().max(256).optional(),
  visibility: z.enum(['visible', 'hidden']).optional(), focused: z.boolean().optional(),
  selection: z.string().max(2048).nullable().optional(), pending_command: z.string().max(128).nullable().optional(),
}).strict()
export type RenderedObservation = z.infer<typeof renderedObservationSchema>
export const deliverySchema = z.object({
  stage: z.enum(['accepted', 'applied-to-state', 'rendered', 'foreground-visible', 'not-visible', 'not-supported']),
  reason: z.string().max(256).optional(), observed_at: z.string().datetime().optional(),
  surface: z.enum(['overview', 'decisions', 'other']).optional(), route: z.string().max(2048).optional(),
  targets: z.array(z.string().max(2048)).max(100).optional(),
  rendered_targets: z.array(z.string().max(2048)).max(100).optional(),
  visible_targets: z.array(z.string().max(2048)).max(100).optional(), pending: z.boolean().optional(),
}).strict()
export type PresentationDelivery = z.infer<typeof deliverySchema>
export function presentationTargets(action: PresentationAction): Target[] {
  if (action.type === 'navigate-card') return [{ kind: 'card', id: action.cardId }]
  if (action.type === 'reveal-search') return [action.target, ...(action.targets ?? [])]
  if (action.type === 'focus') return [action.target]
  return action.type === 'flash' ? action.targets : []
}

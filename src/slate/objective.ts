import {
  OBJECTIVE_ORDER,
  OBJECTIVE_POINT_ID,
  type SlateSurface,
} from '../domain/types'

export type WorkPromptValidation =
  | { ok: true; text: string | undefined }
  | { ok: false; message: string }

/** Validate caller-authored work without changing accepted text beyond trim. */
export function validateExplicitWorkPrompt(
  value: unknown,
  max: number,
): WorkPromptValidation {
  if (value === undefined) return { ok: true, text: undefined }
  if (typeof value !== 'string') return { ok: false, message: 'work prompt must be a string' }
  const text = value.trim()
  if (!text) return { ok: false, message: 'work prompt must not be blank' }
  if (text.length > max) return { ok: false, message: `work prompt exceeds ${max} characters` }
  return { ok: true, text }
}

/** Client projection used before the canonical Objective has reached the Run. */
export function buildObjectiveSurface(text: string, createdAt: string | number): SlateSurface {
  const at = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt)
  const timestamp = Number.isFinite(at) ? at : Date.now()
  return {
    id: OBJECTIVE_POINT_ID,
    author: 'user',
    kind: 'objective',
    order: OBJECTIVE_ORDER,
    headline: text,
    status: 'open',
    createdAt: timestamp,
    amendedAt: timestamp,
  }
}

export function hasCanonicalObjective(run: { slate?: readonly SlateSurface[] }): boolean {
  return run.slate?.some(surface => surface.id === OBJECTIVE_POINT_ID && surface.kind === 'objective') ?? false
}

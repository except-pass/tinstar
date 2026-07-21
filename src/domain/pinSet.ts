// Pure, host+plugin-shared model for canvas pins. Pins are universal per-node
// data stored OFF the entity (like position in config.ui.layouts and snap/
// membership in constellationGraph) — one PinSet per space, revision-gated.
import type { BrowserNoteTarget } from './types'

export interface PinContext {
  /** Browser fills url + target; other widgets leave these undefined. */
  url?: string
  target?: BrowserNoteTarget
  [k: string]: unknown
}

export interface Reply {
  id: string
  /** `'process'` is a Slate thread author (a local `tinstar-run` wrapper posting
   *  onto a point); pins/notes only ever produce `'user'`/`'agent'`, and their
   *  routes reject anything else, so the wider union is inert for them. */
  author: 'user' | 'agent' | 'process'
  text: string
  createdAt: number
}

export interface Pin {
  id: string
  nodeId: string
  /** Normalized 0..1 within the widget's content box (browser interprets these
   *  as document-content coords when it self-renders). */
  nx: number
  ny: number
  comment: string
  createdAt: number
  /** undefined = unsent; set when submitted to the backing session. */
  sentAt?: number
  context?: PinContext
  /** Thread beneath the originating comment (message 0). Append-only; written
   *  exclusively by POST /api/notes/:noteId/replies (the server merge preserves it
   *  across whole-doc PUTs). */
  replies?: Reply[]
  /** Set when the user resolves the note (soft — thread stays readable). */
  resolvedAt?: number
}

export interface PinSet {
  spaceId: string
  pins: Pin[]
  /** Monotonic write revision for conflict resolution (mirrors ConstellationGraph). */
  rev?: number
}

export function emptyPinSet(spaceId: string): PinSet {
  return { spaceId, pins: [], rev: 0 }
}

/** Callers are responsible for generating a unique `id`; addPin does not dedupe. */
export function addPin(set: PinSet, pin: Pin): PinSet {
  return { ...set, pins: [...set.pins, pin] }
}

export function updatePin(set: PinSet, id: string, fn: (p: Pin) => Pin): PinSet {
  let changed = false
  const pins = set.pins.map(p => {
    if (p.id !== id) return p
    changed = true
    return fn(p)
  })
  return changed ? { ...set, pins } : set
}

export function removePin(set: PinSet, id: string): PinSet {
  const pins = set.pins.filter(p => p.id !== id)
  return pins.length === set.pins.length ? set : { ...set, pins }
}

export function removePinsForNode(set: PinSet, nodeId: string): PinSet {
  const pins = set.pins.filter(p => p.nodeId !== nodeId)
  return pins.length === set.pins.length ? set : { ...set, pins }
}

export function pinsForNode(set: PinSet, nodeId: string): Pin[] {
  return set.pins.filter(p => p.nodeId === nodeId)
}

export function isPinSet(v: unknown): v is PinSet {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.spaceId !== 'string' || !Array.isArray(o.pins)) return false
  if (!(o.rev === undefined || (typeof o.rev === 'number' && Number.isSafeInteger(o.rev) && o.rev >= 0))) return false
  return o.pins.every(p => {
    if (p === null || typeof p !== 'object') return false
    const pin = p as Record<string, unknown>
    return typeof pin.id === 'string' && typeof pin.nodeId === 'string' &&
      typeof pin.nx === 'number' && typeof pin.ny === 'number' &&
      typeof pin.comment === 'string' && typeof pin.createdAt === 'number'
  })
}

export function addReply(set: PinSet, pinId: string, reply: Reply): PinSet {
  return updatePin(set, pinId, p => ({ ...p, replies: [...(p.replies ?? []), reply] }))
}

export function resolvePin(set: PinSet, id: string, at: number): PinSet {
  return updatePin(set, id, p => ({ ...p, resolvedAt: at }))
}

export function reopenPin(set: PinSet, id: string): PinSet {
  return updatePin(set, id, p => {
    const { resolvedAt: _drop, ...rest } = p
    return rest
  })
}

/** On a whole-doc PUT, the client must not clobber replies the agent appended
 *  server-side. Take geometry/comment/sentAt/resolvedAt from the client payload
 *  but keep each pin's `replies` from the existing server doc (by id). */
export function mergePreservingReplies(incoming: PinSet, existing?: PinSet): PinSet {
  const prev = new Map((existing?.pins ?? []).map(p => [p.id, p.replies]))
  return {
    ...incoming,
    pins: incoming.pins.map(p => {
      const kept = prev.has(p.id) ? prev.get(p.id) : undefined
      if (kept === undefined) {
        const { replies: _drop, ...rest } = p
        return rest
      }
      return { ...p, replies: kept }
    }),
  }
}

/** The full thread for rendering: the originating comment as message 0 (user),
 *  then the replies in order. The synthetic id is stable for React keys. */
export function threadMessages(pin: Pin): Reply[] {
  return [
    { id: `${pin.id}-root`, author: 'user', text: pin.comment, createdAt: pin.createdAt },
    ...(pin.replies ?? []),
  ]
}

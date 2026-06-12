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
  return { ...set, pins: set.pins.filter(p => p.id !== id) }
}

export function removePinsForNode(set: PinSet, nodeId: string): PinSet {
  return { ...set, pins: set.pins.filter(p => p.nodeId !== nodeId) }
}

export function pinsForNode(set: PinSet, nodeId: string): Pin[] {
  return set.pins.filter(p => p.nodeId === nodeId)
}

export function isPinSet(v: unknown): v is PinSet {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (typeof o.spaceId !== 'string' || !Array.isArray(o.pins)) return false
  return o.pins.every(p => {
    if (p === null || typeof p !== 'object') return false
    const pin = p as Record<string, unknown>
    return typeof pin.id === 'string' && typeof pin.nodeId === 'string' &&
      typeof pin.nx === 'number' && typeof pin.ny === 'number' &&
      typeof pin.comment === 'string' && typeof pin.createdAt === 'number'
  })
}

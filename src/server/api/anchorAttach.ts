// src/server/api/anchorAttach.ts
// Pure parser for the spawn-time `attach` param.
import { DEFAULT_ANCHORS, anchorByName } from '../../domain/anchors'

export interface ParsedAttach { to: string; targetAnchor: string; newAnchor: string }

/** Parse the spawn `attach` param: `{ to, anchors: "<existingAnchor>/<newAnchor>" }`.
 *  Left of `/` is the existing/target widget's anchor; right is the new widget's.
 *  Returns undefined when no attach was requested, null when it is malformed/unknown. */
export function parseAttach(attach: unknown): ParsedAttach | null | undefined {
  if (attach === undefined || attach === null) return undefined
  if (typeof attach !== 'object') return null
  const a = attach as Record<string, unknown>
  if (typeof a.to !== 'string' || a.to === '' || typeof a.anchors !== 'string') return null
  const parts = a.anchors.split('/')
  if (parts.length !== 2) return null
  const [targetAnchor, newAnchor] = parts
  if (!anchorByName(DEFAULT_ANCHORS, targetAnchor!) || !anchorByName(DEFAULT_ANCHORS, newAnchor!)) return null
  return { to: a.to, targetAnchor: targetAnchor!, newAnchor: newAnchor! }
}

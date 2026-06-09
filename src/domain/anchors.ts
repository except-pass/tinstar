// src/domain/anchors.ts
// Pure anchor model: named attachment points in a widget's normalized
// coordinate space (fractions of width/height). Default set is the 4 corners
// + 4 edge midpoints — NO center (center-to-center fully overlaps two widgets,
// an occlusion not a snap; every centered alignment is expressible via an
// edge-midpoint pair). No canvas/Rect dependency so the graph model can import
// the name types without a layering inversion.

export type AnchorName = string
/** A directional attachment: [anchor on node A, anchor on node B] — the two points coincide. */
export type AnchorPair = [AnchorName, AnchorName]

export interface Anchor { name: AnchorName; x: number; y: number }

export const DEFAULT_ANCHORS: Anchor[] = [
  { name: 'top-left', x: 0, y: 0 },
  { name: 'top-center', x: 0.5, y: 0 },
  { name: 'top-right', x: 1, y: 0 },
  { name: 'middle-left', x: 0, y: 0.5 },
  { name: 'middle-right', x: 1, y: 0.5 },
  { name: 'bottom-left', x: 0, y: 1 },
  { name: 'bottom-center', x: 0.5, y: 1 },
  { name: 'bottom-right', x: 1, y: 1 },
]

export function anchorByName(anchors: Anchor[], name: string): Anchor | undefined {
  return anchors.find(a => a.name === name)
}

/** Validate a custom anchor set. Returns an error string, or null when valid. */
export function validateAnchors(anchors: Anchor[]): string | null {
  const seen = new Set<string>()
  for (const a of anchors) {
    if (typeof a.name !== 'string' || a.name === '') return 'anchor name must be non-empty'
    if (seen.has(a.name)) return `duplicate anchor name: ${a.name}`
    seen.add(a.name)
    if (typeof a.x !== 'number' || a.x < 0 || a.x > 1) return `anchor ${a.name}: x must be in [0,1]`
    if (typeof a.y !== 'number' || a.y < 0 || a.y > 1) return `anchor ${a.name}: y must be in [0,1]`
  }
  return null
}

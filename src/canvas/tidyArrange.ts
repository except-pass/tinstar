import { centroidOf, boundingBoxOf } from './constellationCohesion'
import type { Point, Rect } from './constellationCohesion'
import { clusterize } from './clusterize'
import type { ConstellationGraph } from '../domain/constellationGraph'

type LayoutWithId = Rect & { id: string }

/** A rigid group of widgets that arrange tools move as one unit, keeping their
 *  internal formation (snapped adjacency, container nesting) intact. */
export interface RigidBlock {
  members: LayoutWithId[]
  bbox: Rect
}

/**
 * Fold a set of pre-grouped "units" (each unit = the ids of one top-level
 * subtree, e.g. a task container with its runs) into rigid blocks. Two units are
 * fused — so they travel together through an arrange — when they're joined by
 * either a magnetic snap edge OR shared membership in a constellation slot. That
 * keeps a constellation together even when its members were grouped by slot
 * (digit hotkey) without being physically snapped flush. Each block's bbox is
 * the union of its members' current rects. Ids absent from `rectById` are
 * dropped; empty blocks vanish.
 */
export function mergeUnitsByConstellation(
  units: string[][],
  rectById: Map<string, Rect>,
  graph: ConstellationGraph,
): RigidBlock[] {
  // Union-find over unit indices.
  const parent = units.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]! }
    return i
  }
  const union = (a: number, b: number) => { parent[find(a)] = find(b) }

  const unitOf = new Map<string, number>()
  units.forEach((ids, i) => { for (const id of ids) unitOf.set(id, i) })

  // Fuse units sharing a snap edge.
  for (const { nodes: [a, b] } of graph.snapped) {
    const ua = unitOf.get(a), ub = unitOf.get(b)
    if (ua !== undefined && ub !== undefined && ua !== ub) union(ua, ub)
  }

  // Fuse units whose members share a constellation slot — every widget in a slot
  // is pulled into one rigid block so the constellation stays together.
  const slotAnchor = new Map<string, number>()
  for (const { widget, slot } of graph.members) {
    const u = unitOf.get(widget)
    if (u === undefined) continue
    const anchor = slotAnchor.get(slot)
    if (anchor === undefined) slotAnchor.set(slot, u)
    else union(anchor, u)
  }

  const grouped = new Map<number, LayoutWithId[]>()
  units.forEach((ids, i) => {
    const root = find(i)
    const list = grouped.get(root) ?? []
    for (const id of ids) {
      const r = rectById.get(id)
      if (r) list.push({ id, ...r })
    }
    grouped.set(root, list)
  })

  const blocks: RigidBlock[] = []
  for (const members of grouped.values()) {
    if (members.length === 0) continue
    blocks.push({ members, bbox: boundingBoxOf(members)! })
  }
  return blocks
}

/**
 * Shelf/row packer: lay each rigid block left-to-right at its real size, wrapping
 * to a fresh row once the next block would cross `targetWidth`. Each row is as
 * tall as its tallest block. Returns the new top-left for every member, shifted
 * rigidly so snapped/nested formations survive. Blocks never overlap.
 */
export function packBlocksRow(
  blocks: RigidBlock[],
  origin: Point,
  targetWidth: number,
  gap: number,
): Map<string, Point> {
  const out = new Map<string, Point>()
  let cursorX = origin.x
  let cursorY = origin.y
  let rowHeight = 0
  for (const b of blocks) {
    // Wrap before placing (but never wrap an empty row — a single oversized
    // block just overflows its row and the next block wraps past it).
    if (cursorX > origin.x && cursorX + b.bbox.width > origin.x + targetWidth) {
      cursorX = origin.x
      cursorY += rowHeight + gap
      rowHeight = 0
    }
    const dx = cursorX - b.bbox.x
    const dy = cursorY - b.bbox.y
    for (const m of b.members) {
      out.set(m.id, { x: Math.round(m.x + dx), y: Math.round(m.y + dy) })
    }
    cursorX += b.bbox.width + gap
    rowHeight = Math.max(rowHeight, b.bbox.height)
  }
  return out
}

export function tidyGrid(
  layouts: LayoutWithId[],
  gap: number,
): Map<string, Point> {
  const out = new Map<string, Point>()
  if (layouts.length === 0) return out

  const cols = Math.ceil(Math.sqrt(layouts.length))
  const rows = Math.ceil(layouts.length / cols)

  // Uniform cell dimensions = max width / height of any member
  const cellW = Math.max(...layouts.map(l => l.width))
  const cellH = Math.max(...layouts.map(l => l.height))

  const totalW = cols * cellW + (cols - 1) * gap
  const totalH = rows * cellH + (rows - 1) * gap

  const centroid = centroidOf(layouts)!
  const originX = centroid.x - totalW / 2
  const originY = centroid.y - totalH / 2

  layouts.forEach((l, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    out.set(l.id, {
      x: originX + col * (cellW + gap),
      y: originY + row * (cellH + gap),
    })
  })

  return out
}

/** Grid arrange that keeps snap-attached widgets rigid: lays out cluster
 *  bounding boxes on a grid, then shifts each cluster's members by the block
 *  delta. Singletons behave exactly like the old per-widget tidy. */
export function tidyGridClusters(
  layouts: LayoutWithId[],
  graph: ConstellationGraph,
  gap: number,
): Map<string, Point> {
  const blocks = clusterize(layouts, graph)
  const blockRects = blocks.map((b, i) => ({ id: String(i), ...b.bbox }))
  const blockPositions = tidyGrid(blockRects, gap)
  const out = new Map<string, Point>()
  blocks.forEach((b, i) => {
    const np = blockPositions.get(String(i))!
    const dx = np.x - b.bbox.x
    const dy = np.y - b.bbox.y
    for (const m of b.members) out.set(m.id, { x: m.x + dx, y: m.y + dy })
  })
  return out
}

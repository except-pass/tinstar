import { useState, useCallback, useEffect, useRef } from 'react'
import type { TreeNode } from '../domain/types'
import { getWidgetComponent, toWidgetType } from '../widgets/widgetComponentRegistry'
import { useConfig, useDebouncedConfigPatch } from '../context/ConfigContext'
import { packBlocksRow, type RigidBlock } from '../canvas/tidyArrange'
import { boundingBoxOf } from '../canvas/constellationCohesion'

export interface WidgetLayout {
  x: number
  y: number
  width: number
  height: number
}

export interface TreeMaps {
  parentMap: Map<string, string>
  childrenMap: Map<string, string[]>
  descendantsMap: Map<string, Set<string>>
  depthMap: Map<string, number>
}

const LAYOUTS_KEY_PREFIX = 'tinstar-layouts-v3'
const DEFAULT_RUN_WIDTH = 1560
const DEFAULT_RUN_HEIGHT = 1410
export const MIN_WIDTH = 300
export const MIN_HEIGHT = 150

// Depth-aware padding for containers
function getPadding(depth: number) {
  return { padX: 30, padTop: depth === 0 ? 50 : 40, padBottom: 30 }
}

const CONTAINER_GAP = 40
const RUN_GAP = 20

/** Snap all layout fields to integer pixels — prevents sub-pixel rendering that blurs text */
function snap(l: WidgetLayout): WidgetLayout {
  return { x: Math.round(l.x), y: Math.round(l.y), width: Math.round(l.width), height: Math.round(l.height) }
}

// --- Tree map construction ---

function buildTreeMaps(tree: TreeNode[]): TreeMaps {
  const parentMap = new Map<string, string>()
  const childrenMap = new Map<string, string[]>()
  const descendantsMap = new Map<string, Set<string>>()
  const depthMap = new Map<string, number>()

  function walk(nodes: TreeNode[], parentId: string | null, depth: number) {
    for (const node of nodes) {
      if (parentId) parentMap.set(node.id, parentId)
      depthMap.set(node.id, depth)
      childrenMap.set(node.id, node.children.map(c => c.id))
      walk(node.children, node.id, depth + 1)
      // Build descendants (post-order)
      const descs = new Set<string>()
      for (const child of node.children) {
        descs.add(child.id)
        const childDescs = descendantsMap.get(child.id)
        if (childDescs) for (const d of childDescs) descs.add(d)
      }
      descendantsMap.set(node.id, descs)
    }
  }

  walk(tree, null, 0)
  return { parentMap, childrenMap, descendantsMap, depthMap }
}

// --- Default layout generation ---

/**
 * Three-phase recursive layout:
 * 1. Bottom-up sizing: runs get DEFAULT_RUN_WIDTH×HEIGHT, containers wrap children.
 * 2. Root grid packing: ceil(sqrt(n)) columns.
 * 3. Top-down absolutization: parent-relative → absolute canvas coordinates.
 *
 * `prevLayouts`, when given, makes a re-layout *position-only* for leaf widgets:
 * each widget keeps the size the user gave it (floored at its registered
 * minSize) instead of being reset to its default. A widget with no prior layout
 * still falls back to the registered default. Containers always wrap whatever
 * sizes their children resolve to, so preserved (larger) leaves stay contained.
 */
export function generateDefaultLayouts(
  tree: TreeNode[],
  prevLayouts?: Map<string, WidgetLayout>,
): Map<string, WidgetLayout> {
  const layouts = new Map<string, WidgetLayout>()
  const sizeMap = new Map<string, { width: number; height: number }>()

  // Phase 1: Bottom-up sizing
  function computeSize(node: TreeNode, depth: number): { width: number; height: number } {
    const reg = getWidgetComponent(toWidgetType(node.type))
    if (!reg?.isContainer) {
      const prev = prevLayouts?.get(node.id)
      const dw = reg?.defaultSize?.width ?? DEFAULT_RUN_WIDTH
      const dh = reg?.defaultSize?.height ?? DEFAULT_RUN_HEIGHT
      const w = Math.max(reg?.minSize?.width ?? MIN_WIDTH, prev?.width ?? dw)
      const h = Math.max(reg?.minSize?.height ?? MIN_HEIGHT, prev?.height ?? dh)
      const size = { width: w, height: h }
      sizeMap.set(node.id, size)
      return size
    }

    const { padX, padTop, padBottom } = getPadding(depth)
    const hasContainers = node.children.some(
      c => getWidgetComponent(toWidgetType(c.type))?.isContainer,
    )
    const gap = hasContainers ? CONTAINER_GAP : RUN_GAP

    let totalWidth = 0
    let maxHeight = 0

    for (const child of node.children) {
      const cs = computeSize(child, depth + 1)
      totalWidth += cs.width
      maxHeight = Math.max(maxHeight, cs.height)
    }

    totalWidth += Math.max(0, (node.children.length - 1) * gap)

    const size = {
      width: Math.max(200, totalWidth + 2 * padX),
      height: Math.max(100, maxHeight + padTop + padBottom),
    }
    sizeMap.set(node.id, size)
    return size
  }

  for (const root of tree) computeSize(root, 0)

  // Phase 2: Root grid packing
  const cols = Math.max(1, Math.ceil(Math.sqrt(tree.length)))
  let rootX = 50
  let rootY = 50
  let rowMaxH = 0

  for (let i = 0; i < tree.length; i++) {
    if (i > 0 && i % cols === 0) {
      rootX = 50
      rootY += rowMaxH + CONTAINER_GAP
      rowMaxH = 0
    }
    const node = tree[i]!
    const size = sizeMap.get(node.id)!
    layouts.set(node.id, { x: rootX, y: rootY, ...size })
    rootX += size.width + CONTAINER_GAP
    rowMaxH = Math.max(rowMaxH, size.height)
  }

  // Phase 3: Top-down absolutization
  function absolutize(parent: TreeNode, parentLayout: WidgetLayout, depth: number) {
    const { padX, padTop } = getPadding(depth)
    const hasContainers = parent.children.some(
      c => getWidgetComponent(toWidgetType(c.type))?.isContainer,
    )
    const gap = hasContainers ? CONTAINER_GAP : RUN_GAP
    let childX = padX

    for (const child of parent.children) {
      const childSize = sizeMap.get(child.id)!
      layouts.set(child.id, {
        x: parentLayout.x + childX,
        y: parentLayout.y + padTop,
        ...childSize,
      })
      if (child.children.length > 0) {
        absolutize(child, layouts.get(child.id)!, depth + 1)
      }
      childX += childSize.width + gap
    }
  }

  for (const root of tree) {
    if (root.children.length > 0) absolutize(root, layouts.get(root.id)!, 0)
  }

  return layouts
}

/**
 * Keep cohesion groups (constellation members) together through a full re-layout.
 *
 * A re-layout (`generateDefaultLayouts`) positions every widget independently
 * from the tree, which scatters the members of a constellation — a session and
 * its attached browser, say — into separate cells and dissolves the snapped
 * formation the user built. This re-anchors each group as a rigid block: one
 * member keeps its fresh position and the others are offset from it by their
 * pre-arrange relative positions, so snapped adjacency survives the arrange.
 *
 * Mutates and returns `fresh`. Members absent from either map are skipped (never
 * created); a group with fewer than two live members is left untouched.
 */
export function preserveCohesion(
  fresh: Map<string, WidgetLayout>,
  prev: Map<string, WidgetLayout>,
  groups: string[][],
): Map<string, WidgetLayout> {
  for (const group of groups) {
    const members = group.filter(id => fresh.has(id) && prev.has(id))
    if (members.length < 2) continue
    // Anchor = the member the fresh layout placed top-most-left, so the block
    // moves to the earliest of its members' arranged slots (least disruptive).
    const anchor = members.reduce((best, id) => {
      const a = fresh.get(best)!, b = fresh.get(id)!
      return b.y < a.y || (b.y === a.y && b.x < a.x) ? id : best
    })
    const anchorFresh = fresh.get(anchor)!
    const anchorPrev = prev.get(anchor)!
    for (const id of members) {
      if (id === anchor) continue
      const p = prev.get(id)!
      const cur = fresh.get(id)!
      fresh.set(id, {
        ...cur,
        x: anchorFresh.x + (p.x - anchorPrev.x),
        y: anchorFresh.y + (p.y - anchorPrev.y),
      })
    }
  }
  return fresh
}

/**
 * Step 3 of the Reset/Arrange pipeline: re-pack the root grid by rigid block so
 * each constellation reserves its full bounding box and nothing else is placed
 * inside it. Without this, `preserveCohesion` collapses a snapped member (e.g. a
 * browser) toward its anchor into a cell the grid handed to a *different* root,
 * landing the formation on top of that neighbour.
 *
 * Blocks are formed from `cohesionGroups` alone (no constellation graph needed):
 * each group's member ids are mapped up to their top-level root via
 * `treeMaps.parentMap`, and the top-level subtrees that share a group are unioned
 * into one block. Every other top-level subtree is a singleton block. A block's
 * members are all layout-bearing ids in its subtree(s); its bbox is the union of
 * their current (post-`preserveCohesion`) rects.
 *
 * The block bounding boxes are packed on the default grid shape (≈`ceil(sqrt(n))`
 * columns) reserving each block's real footprint, then every member is shifted
 * rigidly by its block delta — so formations stay snapped and no block overlaps
 * another. When no group spans more than one top-level root there is nothing to
 * reserve and the input is returned unchanged (the common path).
 */
export function blockRepack(
  layouts: Map<string, WidgetLayout>,
  treeMaps: TreeMaps,
  cohesionGroups: string[][],
): Map<string, WidgetLayout> {
  // Map any layout id up to its top-level root id.
  const rootOf = (id: string): string => {
    let cur = id
    for (;;) {
      const p = treeMaps.parentMap.get(cur)
      if (p === undefined) return cur
      cur = p
    }
  }

  // Bucket every layout-bearing id under its top-level root.
  const idsByRoot = new Map<string, string[]>()
  for (const id of layouts.keys()) {
    const root = rootOf(id)
    const list = idsByRoot.get(root)
    if (list) list.push(id)
    else idsByRoot.set(root, [id])
  }
  const roots = [...idsByRoot.keys()]
  const rootIndex = new Map(roots.map((r, i) => [r, i]))

  // Union-find over top-level roots: fuse roots that share a cohesion group.
  const parent = roots.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]!]!; i = parent[i]! }
    return i
  }
  let merged = false
  for (const group of cohesionGroups) {
    const groupRoots = group
      .filter(id => layouts.has(id))
      .map(id => rootIndex.get(rootOf(id)))
      .filter((i): i is number => i !== undefined)
    for (let k = 1; k < groupRoots.length; k++) {
      const a = find(groupRoots[0]!), b = find(groupRoots[k]!)
      if (a !== b) { parent[a] = b; merged = true }
    }
  }
  // No constellation spans more than one top-level root → footprints already
  // reserved by the default grid; nothing to do.
  if (!merged) return layouts

  // Assemble rigid blocks: members + union bbox.
  const blockMembers = new Map<number, RigidBlock['members']>()
  for (const root of roots) {
    const b = find(rootIndex.get(root)!)
    const list = blockMembers.get(b) ?? []
    for (const id of idsByRoot.get(root)!) {
      const l = layouts.get(id)!
      list.push({ id, x: l.x, y: l.y, width: l.width, height: l.height })
    }
    blockMembers.set(b, list)
  }
  const blocks: RigidBlock[] = [...blockMembers.values()].map(members => ({
    members,
    bbox: boundingBoxOf(members)!,
  }))
  // Stable reading order (top-to-bottom, left-to-right) so the grid is deterministic.
  blocks.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x)

  // Pack block footprints into a roughly-square grid: aim for ceil(sqrt(n))
  // columns of the widest block, and let packBlocksRow row-wrap at that width.
  const cols = Math.max(1, Math.ceil(Math.sqrt(blocks.length)))
  const maxBlockWidth = Math.max(...blocks.map(b => b.bbox.width))
  const targetWidth = cols * (maxBlockWidth + CONTAINER_GAP)
  const positions = packBlocksRow(blocks, { x: 50, y: 50 }, targetWidth, CONTAINER_GAP)

  // Apply the rigid per-member shift, preserving each widget's size.
  const out = new Map(layouts)
  for (const [id, p] of positions) {
    const l = out.get(id)!
    out.set(id, snap({ ...l, x: p.x, y: p.y }))
  }
  return out
}

/**
 * Pure layout pipeline behind the Reset/Arrange-workspace action. Kept exported
 * and DOM-free so the placement logic can be unit-tested directly.
 *
 *   1. `generateDefaultLayouts(tree, prev)` — tidy default grid at current sizes.
 *   2. `preserveCohesion(...)`              — re-snap each constellation as a rigid
 *                                             block (anchor-relative offsets).
 *   3. `blockRepack(...)`                   — re-pack the *root grid by rigid block*
 *                                             so each formation reserves its full
 *                                             bounding box and nothing overlaps.
 *
 * With no cohesion groups the result is exactly `generateDefaultLayouts(tree, prev)`.
 */
export function arrangeLayouts(
  tree: TreeNode[],
  prev: Map<string, WidgetLayout>,
  treeMaps: TreeMaps,
  cohesionGroups?: string[][],
): Map<string, WidgetLayout> {
  const fresh = generateDefaultLayouts(tree, prev)
  if (!cohesionGroups?.length) return fresh
  preserveCohesion(fresh, prev, cohesionGroups)
  return blockRepack(fresh, treeMaps, cohesionGroups)
}

// --- Smart placement for new nodes ---

/**
 * Place new run nodes near their existing siblings rather than using the
 * full grid-from-scratch position. For each missing run:
 *   1. Find the rightmost sibling that already has a position → place to its right.
 *   2. No siblings yet → place inside the parent container (top-left corner).
 *   3. No parent positioned either → return nothing (caller falls back to defaults).
 *
 * Container nodes are not handled here; callers should cascadeExpansion after
 * placing runs so parent containers expand to contain them.
 */
function placeNewRuns(
  missingIds: Set<string>,
  tree: TreeNode[],
  existing: Map<string, WidgetLayout>,
  treeMaps: TreeMaps,
): Map<string, WidgetLayout> {
  const nodeMap = new Map<string, TreeNode>()
  function index(nodes: TreeNode[]) {
    for (const n of nodes) { nodeMap.set(n.id, n); index(n.children) }
  }
  index(tree)

  const placed = new Map<string, WidgetLayout>()

  for (const id of missingIds) {
    const node = nodeMap.get(id)
    const nodeReg = getWidgetComponent(toWidgetType(node?.type ?? ''))
    if (!node || nodeReg?.isContainer) continue

    const w = nodeReg?.defaultSize?.width ?? DEFAULT_RUN_WIDTH
    const h = nodeReg?.defaultSize?.height ?? DEFAULT_RUN_HEIGHT

    const parentId = treeMaps.parentMap.get(id)
    const parent = parentId ? nodeMap.get(parentId) : null
    if (!parent) continue

    // Find rightmost positioned sibling
    let maxRight = -Infinity
    let refY: number | null = null
    for (const sib of parent.children) {
      if (sib.id === id) continue
      const sl = existing.get(sib.id) ?? placed.get(sib.id)
      if (!sl) continue
      if (sl.x + sl.width > maxRight) { maxRight = sl.x + sl.width; refY = sl.y }
    }

    if (refY !== null) {
      placed.set(id, snap({ x: maxRight + RUN_GAP, y: refY, width: w, height: h }))
      continue
    }

    // No siblings — place inside parent container if parent is positioned
    const parentLayout = existing.get(parentId!) ?? placed.get(parentId!)
    if (parentLayout) {
      const depth = treeMaps.depthMap.get(parentId!) ?? 0
      const { padX, padTop } = getPadding(depth)
      placed.set(id, snap({ x: parentLayout.x + padX, y: parentLayout.y + padTop, width: w, height: h }))
    }
    // else: no reference found — caller will fall back to generateDefaultLayouts
  }

  return placed
}

// --- Collect all node IDs ---

function collectTreeIds(tree: TreeNode[]): Set<string> {
  const ids = new Set<string>()
  function walk(nodes: TreeNode[]) {
    for (const n of nodes) {
      ids.add(n.id)
      walk(n.children)
    }
  }
  walk(tree)
  return ids
}

// --- Persistence ---

/**
 * Hydrate a layouts Map from an already-loaded persisted record (id → WidgetLayout).
 * Used to seed local state from config.ui.layouts[storageKey]. Filling/regeneration
 * policy matches the previous loader (regenerate from scratch if >20% missing,
 * otherwise fill missing nodes via smart placement or defaults).
 */
// Exported for unit tests. Pure: derives the initial layout Map for a tree from
// persisted state, the host-provided placement seed, smart placement, and
// defaults — in that precedence.
export function hydrateLayouts(
  tree: TreeNode[],
  persisted: Record<string, WidgetLayout> | null | undefined,
  seed?: Map<string, WidgetLayout>,
): Map<string, WidgetLayout> {
  const allIds = collectTreeIds(tree)
  // Overlay the host-provided placement seed onto a from-scratch layout so a
  // seeded widget (e.g. a browser widget opened at a chosen spot / nearNodeId)
  // lands where requested even when we fall back to default generation — a
  // fresh space with no persisted layouts, or a >20%-missing regeneration.
  const withSeed = (base: Map<string, WidgetLayout>): Map<string, WidgetLayout> => {
    if (seed) for (const [id, layout] of seed) if (allIds.has(id)) base.set(id, layout)
    return base
  }
  if (!persisted) return withSeed(generateDefaultLayouts(tree))
  try {
    const map = new Map<string, WidgetLayout>()
    for (const id of allIds) {
      const saved = persisted[id]
      if (saved && typeof saved.x === 'number') map.set(id, snap(saved))
    }
    // Also load any saved positions not in the current tree
    // (e.g. editor widgets arriving via SSE after initial mount)
    for (const [id, layout] of Object.entries(persisted)) {
      if (!map.has(id) && layout && typeof (layout as WidgetLayout).x === 'number') {
        map.set(id, snap(layout as WidgetLayout))
      }
    }
    // If >20% missing, regenerate from scratch
    if (map.size < allIds.size * 0.8) return withSeed(generateDefaultLayouts(tree))
    // Fill any remaining missing with the host-provided placement seed (e.g. a
    // browser widget opened at a chosen spot), then smart placement (near
    // siblings), then defaults.
    if (map.size < allIds.size) {
      const missing = new Set([...allIds].filter(id => !map.has(id)))
      const treeMaps = buildTreeMaps(tree)
      const smart = placeNewRuns(missing, tree, map, treeMaps)
      const defaults = generateDefaultLayouts(tree)
      for (const id of missing) {
        map.set(id, seed?.get(id) ?? smart.get(id) ?? defaults.get(id)!)
      }
      for (const id of missing) {
        if (seed?.has(id) || smart.has(id)) cascadeExpansion(map, id, treeMaps)
      }
    }
    return map
  } catch {
    return withSeed(generateDefaultLayouts(tree))
  }
}

function layoutsToRecord(layouts: Map<string, WidgetLayout>): Record<string, WidgetLayout> {
  const obj: Record<string, WidgetLayout> = {}
  for (const [id, layout] of layouts) obj[id] = layout
  return obj
}

// --- Enforce containment ---

function enforceContainsChild(
  map: Map<string, WidgetLayout>,
  parentId: string,
  childLayout: WidgetLayout,
  depth: number,
) {
  const parent = map.get(parentId)
  if (!parent) return
  const { padX, padTop, padBottom } = getPadding(depth)
  let changed = false
  let { x, y, width, height } = parent

  if (childLayout.x - padX < x) {
    const shift = x - (childLayout.x - padX)
    width += shift
    x = childLayout.x - padX
    changed = true
  }
  if (childLayout.y - padTop < y) {
    const shift = y - (childLayout.y - padTop)
    height += shift
    y = childLayout.y - padTop
    changed = true
  }
  const neededW = (childLayout.x + childLayout.width + padX) - x
  if (neededW > width) { width = neededW; changed = true }
  const neededH = (childLayout.y + childLayout.height + padBottom) - y
  if (neededH > height) { height = neededH; changed = true }

  if (changed) map.set(parentId, snap({ x, y, width, height }))
}

/** Walk up parent chain expanding as needed */
function cascadeExpansion(
  map: Map<string, WidgetLayout>,
  startNodeId: string,
  treeMaps: TreeMaps,
) {
  let nodeId: string | undefined = startNodeId
  while (nodeId) {
    const parentId = treeMaps.parentMap.get(nodeId)
    if (!parentId) break
    const nodeLayout = map.get(nodeId)
    if (!nodeLayout) break
    const parentDepth = treeMaps.depthMap.get(parentId) ?? 0
    enforceContainsChild(map, parentId, nodeLayout, parentDepth)
    nodeId = parentId
  }
}

/** Compute min bounds for a container from its children (lower-right only — upper-left stays fixed) */
function computeMinBounds(
  map: Map<string, WidgetLayout>,
  parentLayout: WidgetLayout,
  childIds: string[],
  depth: number,
): { minWidth: number; minHeight: number } {
  const { padX, padBottom } = getPadding(depth)
  let maxRight = -Infinity
  let maxBottom = -Infinity
  for (const cid of childIds) {
    const c = map.get(cid)
    if (!c) continue
    maxRight = Math.max(maxRight, c.x + c.width)
    maxBottom = Math.max(maxBottom, c.y + c.height)
  }
  if (maxRight === -Infinity) return { minWidth: 200, minHeight: 100 }
  return {
    minWidth: maxRight - parentLayout.x + padX,
    minHeight: maxBottom - parentLayout.y + padBottom,
  }
}

/** Compute tight bounding box for a container by hugging all four edges of its children */
function computeTightBounds(
  map: Map<string, WidgetLayout>,
  childIds: string[],
  depth: number,
): WidgetLayout | null {
  const { padX, padTop, padBottom } = getPadding(depth)
  let minLeft = Infinity
  let minTop = Infinity
  let maxRight = -Infinity
  let maxBottom = -Infinity
  for (const cid of childIds) {
    const c = map.get(cid)
    if (!c) continue
    minLeft = Math.min(minLeft, c.x)
    minTop = Math.min(minTop, c.y)
    maxRight = Math.max(maxRight, c.x + c.width)
    maxBottom = Math.max(maxBottom, c.y + c.height)
  }
  if (minLeft === Infinity) return null
  return snap({
    x: minLeft - padX,
    y: minTop - padTop,
    width: maxRight - minLeft + padX * 2,
    height: maxBottom - minTop + padTop + padBottom,
  })
}

// --- The hook ---

/**
 * @param seedLayouts Optional id→layout seed for nodes that have no persisted
 *   layout yet — used by the host placement API to open a widget (e.g. a browser
 *   widget) at a chosen canvas spot. Consulted only on a node's first appearance;
 *   once placed it flows into config.ui.layouts and user drags take over.
 */
export function useWidgetLayouts(tree: TreeNode[], spaceId?: string, seedLayouts?: Map<string, WidgetLayout>) {
  const storageKey = spaceId ? `${LAYOUTS_KEY_PREFIX}-${spaceId}` : LAYOUTS_KEY_PREFIX
  const storageKeyRef = useRef(storageKey)
  const seedRef = useRef(seedLayouts)
  seedRef.current = seedLayouts

  const config = useConfig()
  const patchConfig = useDebouncedConfigPatch(500)

  // Read-once-on-mount seed from config (config may still be null on first render —
  // we hydrate when it arrives via the effect below).
  const initialPersistedRef = useRef<Record<string, WidgetLayout> | null>(
    (config?.ui.layouts as Record<string, Record<string, WidgetLayout>> | undefined)?.[storageKey] ?? null,
  )
  const hydratedRef = useRef<boolean>(initialPersistedRef.current !== null)

  const [layouts, setLayouts] = useState<Map<string, WidgetLayout>>(() =>
    hydrateLayouts(tree, initialPersistedRef.current, seedRef.current),
  )
  const layoutsRef = useRef(layouts)
  layoutsRef.current = layouts

  // When the next layouts change is itself a hydration from the server, we
  // don't want the persistence effect to echo it right back as a PATCH.
  const skipNextPersistRef = useRef(false)

  // When config first arrives (or storage key flips), hydrate layouts from it.
  useEffect(() => {
    if (!config) return
    const all = config.ui.layouts as Record<string, Record<string, WidgetLayout>> | undefined
    const persisted = all?.[storageKeyRef.current] ?? null
    if (!hydratedRef.current && persisted) {
      hydratedRef.current = true
      const fresh = hydrateLayouts(tree, persisted, seedRef.current)
      layoutsRef.current = fresh
      // Hydration arrives from server — don't echo it back as a PATCH.
      skipNextPersistRef.current = true
      setLayouts(fresh)
    }
    // We intentionally only hydrate once per storageKey; ongoing config changes
    // come from our own writes and would clobber in-flight drag state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, storageKey])

  const treeMapsRef = useRef<TreeMaps>(buildTreeMaps(tree))
  const prevTreeRef = useRef(tree)

  // Rebuild tree maps + detect dimension changes
  if (tree !== prevTreeRef.current) {
    treeMapsRef.current = buildTreeMaps(tree)
    prevTreeRef.current = tree

    // Dimension change detection: >20% new IDs → regenerate; otherwise fill missing
    const newIds = collectTreeIds(tree)
    let missing = 0
    for (const id of newIds) {
      if (!layoutsRef.current.has(id)) missing++
    }
    if (newIds.size > 0 && missing > 0) {
      if (missing / newIds.size > 0.2) {
        const fresh = generateDefaultLayouts(tree)
        layoutsRef.current = fresh
        queueMicrotask(() => setLayouts(fresh))
      } else {
        // Fill in missing nodes: prefer a host-provided placement seed (e.g. a
        // browser widget opened at a chosen spot), then place runs near
        // siblings/parent, then fall back to defaults for containers.
        const missing = new Set([...newIds].filter(id => !layoutsRef.current.has(id)))
        const smart = placeNewRuns(missing, tree, layoutsRef.current, treeMapsRef.current)
        const defaults = generateDefaultLayouts(tree)
        const seed = seedRef.current
        const patched = new Map(layoutsRef.current)
        for (const id of missing) {
          patched.set(id, seed?.get(id) ?? smart.get(id) ?? defaults.get(id)!)
        }
        // Expand parent containers to contain any newly placed/seeded runs
        for (const id of missing) {
          if (seed?.has(id) || smart.has(id)) cascadeExpansion(patched, id, treeMapsRef.current)
        }
        layoutsRef.current = patched
        // Apply as a FUNCTIONAL MERGE rather than a value-set. prevTreeRef has already
        // advanced to this tree, so the missing-node detection above won't run again —
        // if this state update were lost (clobbered by a concurrent setLayouts, e.g. a
        // pending-run insert or a drag persist that built on an earlier snapshot), the
        // new run would stay absent from the rendered `layouts` forever and render
        // nothing on the canvas until Arrange regenerates everything (the reported bug:
        // session shows in the hierarchy but not on the canvas). Merging only the newly
        // placed ids into whatever the current state is can't be clobbered and never
        // drops an existing entry.
        const placed = new Map([...missing].map(id => [id, patched.get(id)!] as const))
        queueMicrotask(() => setLayouts(prev => {
          let changed = false
          const next = new Map(prev)
          for (const [id, layout] of placed) if (!next.has(id)) { next.set(id, layout); changed = true }
          return changed ? next : prev
        }))
      }
    }
  }

  // Reload layouts when space changes
  if (storageKey !== storageKeyRef.current) {
    storageKeyRef.current = storageKey
    hydratedRef.current = false
    const all = config?.ui.layouts as Record<string, Record<string, WidgetLayout>> | undefined
    const persisted = all?.[storageKey] ?? null
    if (persisted) hydratedRef.current = true
    const fresh = hydrateLayouts(tree, persisted, seedRef.current)
    layoutsRef.current = fresh
    // Space switch is a hydration from persisted state — don't echo back.
    if (persisted) skipNextPersistRef.current = true
    queueMicrotask(() => setLayouts(fresh))
  }

  // Persist on change — debounced (500ms) to coalesce window-drag churn.
  // The first render is purely a hydration step (we just loaded from config),
  // so skip writing it back.
  //
  // The server PATCH handler deep-merges `ui.layouts`, so sending only our
  // storageKey here is safe — other spaces' entries are preserved server-side.
  // The optimistic client merge is shallower (replaces ui.layouts wholesale)
  // but the next /api/config response from the server reconciles.
  const firstPersistRef = useRef(true)
  const configLayoutsRef = useRef<Record<string, Record<string, WidgetLayout>>>({})
  configLayoutsRef.current = (config?.ui.layouts as Record<string, Record<string, WidgetLayout>> | undefined) ?? {}
  useEffect(() => {
    if (firstPersistRef.current) {
      firstPersistRef.current = false
      return
    }
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false
      return
    }
    // Carry forward other storage keys' entries in the same PATCH so the
    // client-side optimistic merge (which replaces ui.layouts wholesale)
    // doesn't visibly drop them between request and server response.
    const merged: Record<string, Record<string, WidgetLayout>> = {
      ...configLayoutsRef.current,
      [storageKeyRef.current]: layoutsToRecord(layouts),
    }
    patchConfig({ ui: { layouts: merged } })
  }, [layouts, patchConfig])

  // Move a run (leaf), auto-expand ancestor chain
  const updateRunPosition = useCallback((id: string, x: number, y: number) => {
    setLayouts(prev => {
      const next = new Map(prev)
      const existing = next.get(id)
      if (!existing) return prev
      next.set(id, { ...existing, x, y })
      cascadeExpansion(next, id, treeMapsRef.current)
      return next
    })
  }, [])

  // Resize a run (leaf), auto-expand ancestor chain
  const updateRunSize = useCallback((id: string, width: number, height: number) => {
    setLayouts(prev => {
      const next = new Map(prev)
      const existing = next.get(id)
      if (!existing) return prev
      next.set(id, {
        ...existing,
        width: Math.max(MIN_WIDTH, width),
        height: Math.max(MIN_HEIGHT, height),
      })
      cascadeExpansion(next, id, treeMapsRef.current)
      return next
    })
  }, [])

  // Move a node + all descendants by delta
  const moveNode = useCallback((nodeId: string, newX: number, newY: number) => {
    setLayouts(prev => {
      const next = new Map(prev)
      const node = next.get(nodeId)
      if (!node) return prev
      const dx = newX - node.x
      const dy = newY - node.y
      next.set(nodeId, { ...node, x: newX, y: newY })

      // Move all descendants
      const descs = treeMapsRef.current.descendantsMap.get(nodeId)
      if (descs) {
        for (const descId of descs) {
          const d = next.get(descId)
          if (d) next.set(descId, { ...d, x: d.x + dx, y: d.y + dy })
        }
      }

      // Cascade expansion up from this node
      cascadeExpansion(next, nodeId, treeMapsRef.current)
      return next
    })
  }, [])

  // Resize a node with min-bounds enforcement
  const resizeNode = useCallback((nodeId: string, width: number, height: number) => {
    setLayouts(prev => {
      const next = new Map(prev)
      const node = next.get(nodeId)
      if (!node) return prev
      const childIds = treeMapsRef.current.childrenMap.get(nodeId) ?? []
      const depth = treeMapsRef.current.depthMap.get(nodeId) ?? 0
      if (childIds.length > 0) {
        const { minWidth, minHeight } = computeMinBounds(next, node, childIds, depth)
        next.set(nodeId, {
          ...node,
          width: Math.max(width, minWidth),
          height: Math.max(height, minHeight),
        })
      } else {
        next.set(nodeId, { ...node, width: Math.max(MIN_WIDTH, width), height: Math.max(MIN_HEIGHT, height) })
      }
      return next
    })
  }, [])

  // Recursive bottom-up shrink-to-fit
  const shrinkNode = useCallback((nodeId: string) => {
    setLayouts(prev => {
      const next = new Map(prev)
      const tm = treeMapsRef.current

      function shrink(nid: string) {
        const childIds = tm.childrenMap.get(nid) ?? []
        // Shrink children first (bottom-up)
        for (const cid of childIds) {
          if ((tm.childrenMap.get(cid) ?? []).length > 0) shrink(cid)
        }
        const node = next.get(nid)
        if (!node) return
        if (childIds.length === 0) {
          // Empty container — collapse to compact size, keep position
          next.set(nid, snap({ x: node.x, y: node.y, width: MIN_WIDTH, height: MIN_HEIGHT }))
          return
        }
        const depth = tm.depthMap.get(nid) ?? 0
        const tight = computeTightBounds(next, childIds, depth)
        if (tight) next.set(nid, tight)
      }

      shrink(nodeId)

      // Cascade tightening upward so ancestor containers also hug their (now-shrunken) children
      let current = nodeId
      while (true) {
        const parentId = tm.parentMap.get(current)
        if (!parentId) break
        const parentChildIds = tm.childrenMap.get(parentId) ?? []
        if (parentChildIds.length === 0) break
        const parentDepth = tm.depthMap.get(parentId) ?? 0
        const parentTight = computeTightBounds(next, parentChildIds, parentDepth)
        if (parentTight) next.set(parentId, parentTight)
        current = parentId
      }

      return next
    })
  }, [])

  const getLayout = useCallback(
    (id: string): WidgetLayout | undefined => layoutsRef.current.get(id),
    [],
  )

  // Full re-layout. `cohesionGroups` (constellation members, by node id) are kept
  // together as rigid blocks so a re-layout doesn't scatter snapped widgets —
  // e.g. a session and its attached browser stay linked. Passing `prev` keeps
  // each widget at its current size (this is a tidy-positions arrange, not a
  // size reset), so a hand-sized browser isn't shrunk back to its default.
  const arrangeWorkspace = useCallback((cohesionGroups?: string[][]) => {
    setLayouts(prev => arrangeLayouts(tree, prev, treeMapsRef.current, cohesionGroups))
  }, [tree])

  const insertLayout = useCallback((id: string, layout: WidgetLayout) => {
    layoutsRef.current = new Map(layoutsRef.current).set(id, layout)
    setLayouts(new Map(layoutsRef.current))
  }, [])

  // Apply many layout updates in a single state transition (no cascadeExpansion —
  // caller is responsible for computing correct sizes top-down)
  const batchSetLayouts = useCallback((updates: Map<string, WidgetLayout>) => {
    setLayouts(prev => {
      const next = new Map(prev)
      for (const [id, layout] of updates) next.set(id, layout)
      return next
    })
  }, [])

  return {
    layouts,
    treeMaps: treeMapsRef.current,
    updateRunPosition,
    updateRunSize,
    moveNode,
    resizeNode,
    shrinkNode,
    getLayout,
    arrangeWorkspace,
    insertLayout,
    batchSetLayouts,
  }
}

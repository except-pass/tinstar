import { useState, useCallback, useEffect, useRef } from 'react'
import type { TreeNode } from '../domain/types'
import { getWidgetComponent, toWidgetType } from '../widgets/widgetComponentRegistry'

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

const STORAGE_KEY_PREFIX = 'tinstar-layouts-v3'
const DEFAULT_RUN_WIDTH = 880
const DEFAULT_RUN_HEIGHT = 820
const MIN_WIDTH = 300
const MIN_HEIGHT = 150

// Depth-aware padding for containers
function getPadding(depth: number) {
  return { padX: 30, padTop: depth === 0 ? 50 : 40, padBottom: 30 }
}

const CONTAINER_GAP = 40
const RUN_GAP = 20

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
 */
function generateDefaultLayouts(tree: TreeNode[]): Map<string, WidgetLayout> {
  const layouts = new Map<string, WidgetLayout>()
  const sizeMap = new Map<string, { width: number; height: number }>()

  // Phase 1: Bottom-up sizing
  function computeSize(node: TreeNode, depth: number): { width: number; height: number } {
    const reg = getWidgetComponent(toWidgetType(node.type))
    if (!reg?.isContainer) {
      const w = reg?.defaultSize?.width ?? DEFAULT_RUN_WIDTH
      const h = reg?.defaultSize?.height ?? DEFAULT_RUN_HEIGHT
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
      placed.set(id, { x: maxRight + RUN_GAP, y: refY, width: w, height: h })
      continue
    }

    // No siblings — place inside parent container if parent is positioned
    const parentLayout = existing.get(parentId!) ?? placed.get(parentId!)
    if (parentLayout) {
      const depth = treeMaps.depthMap.get(parentId!) ?? 0
      const { padX, padTop } = getPadding(depth)
      placed.set(id, { x: parentLayout.x + padX, y: parentLayout.y + padTop, width: w, height: h })
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

function loadLayouts(tree: TreeNode[], storageKey: string): Map<string, WidgetLayout> {
  const allIds = collectTreeIds(tree)
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return generateDefaultLayouts(tree)
    const parsed = JSON.parse(raw) as Record<string, WidgetLayout>
    const map = new Map<string, WidgetLayout>()
    for (const id of allIds) {
      const saved = parsed[id]
      if (saved && typeof saved.x === 'number') map.set(id, saved)
    }
    // Also load any saved positions not in the current tree
    // (e.g. editor widgets arriving via SSE after initial mount)
    for (const [id, layout] of Object.entries(parsed)) {
      if (!map.has(id) && typeof (layout as WidgetLayout).x === 'number') {
        map.set(id, layout as WidgetLayout)
      }
    }
    // If >20% missing, regenerate from scratch
    if (map.size < allIds.size * 0.8) return generateDefaultLayouts(tree)
    // Fill any remaining missing with smart placement (near siblings) or defaults
    if (map.size < allIds.size) {
      const missing = new Set([...allIds].filter(id => !map.has(id)))
      const treeMaps = buildTreeMaps(tree)
      const smart = placeNewRuns(missing, tree, map, treeMaps)
      const defaults = generateDefaultLayouts(tree)
      for (const id of missing) {
        map.set(id, smart.get(id) ?? defaults.get(id)!)
      }
      for (const id of smart.keys()) {
        cascadeExpansion(map, id, treeMaps)
      }
    }
    return map
  } catch {
    return generateDefaultLayouts(tree)
  }
}

function saveLayouts(layouts: Map<string, WidgetLayout>, storageKey: string) {
  const obj: Record<string, WidgetLayout> = {}
  for (const [id, layout] of layouts) obj[id] = layout
  localStorage.setItem(storageKey, JSON.stringify(obj))
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

  if (changed) map.set(parentId, { x, y, width, height })
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

/** Compute min bounds for a container from its children */
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

// --- The hook ---

export function useWidgetLayouts(tree: TreeNode[], spaceId?: string) {
  const storageKey = spaceId ? `${STORAGE_KEY_PREFIX}-${spaceId}` : STORAGE_KEY_PREFIX
  const storageKeyRef = useRef(storageKey)

  const [layouts, setLayouts] = useState<Map<string, WidgetLayout>>(() =>
    loadLayouts(tree, storageKey),
  )
  const layoutsRef = useRef(layouts)
  layoutsRef.current = layouts

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
        // Fill in missing nodes: place runs near siblings/parent, fall back to defaults for containers
        const missing = new Set([...newIds].filter(id => !layoutsRef.current.has(id)))
        const smart = placeNewRuns(missing, tree, layoutsRef.current, treeMapsRef.current)
        const defaults = generateDefaultLayouts(tree)
        const patched = new Map(layoutsRef.current)
        for (const id of missing) {
          patched.set(id, smart.get(id) ?? defaults.get(id)!)
        }
        // Expand parent containers to contain any newly placed runs
        for (const id of smart.keys()) {
          cascadeExpansion(patched, id, treeMapsRef.current)
        }
        layoutsRef.current = patched
        queueMicrotask(() => setLayouts(patched))
      }
    }
  }

  // Reload layouts when space changes
  if (storageKey !== storageKeyRef.current) {
    storageKeyRef.current = storageKey
    const fresh = loadLayouts(tree, storageKey)
    layoutsRef.current = fresh
    queueMicrotask(() => setLayouts(fresh))
  }

  // Persist on change
  useEffect(() => {
    saveLayouts(layouts, storageKeyRef.current)
  }, [layouts])

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
        if (childIds.length === 0) return
        const node = next.get(nid)
        if (!node) return
        const depth = tm.depthMap.get(nid) ?? 0
        const { minWidth, minHeight } = computeMinBounds(next, node, childIds, depth)
        next.set(nid, { ...node, width: minWidth, height: minHeight })
      }

      shrink(nodeId)
      return next
    })
  }, [])

  const getLayout = useCallback(
    (id: string): WidgetLayout | undefined => layoutsRef.current.get(id),
    [],
  )

  // Full re-layout
  const arrangeWorkspace = useCallback(() => {
    setLayouts(generateDefaultLayouts(tree))
  }, [tree])

  const insertLayout = useCallback((id: string, layout: WidgetLayout) => {
    layoutsRef.current = new Map(layoutsRef.current).set(id, layout)
    setLayouts(new Map(layoutsRef.current))
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
  }
}

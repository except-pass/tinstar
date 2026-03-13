import { useRef, useState, useCallback } from 'react'
import type { TreeNode, GroupingDimension } from '../domain/types'

const DRAG_THRESHOLD = 4
const NEST_INDENT_PX = 24
const AUTO_EXPAND_DELAY = 500
const EDGE_SCROLL_ZONE = 40
const EDGE_SCROLL_SPEED = 8

export type DropPosition = 'before' | 'after' | 'inside'

export interface DropTarget {
  nodeId: string
  position: DropPosition
}

interface DragState {
  nodeId: string
  nodeType: string
  label: string
  startY: number
  startX: number
  currentY: number
}

/** Check if candidateId is a descendant of ancestorId in the tree */
function isDescendant(tree: TreeNode[], ancestorId: string, candidateId: string): boolean {
  function find(nodes: TreeNode[]): TreeNode | null {
    for (const n of nodes) {
      if (n.id === ancestorId) return n
      const found = find(n.children)
      if (found) return found
    }
    return null
  }
  const ancestor = find(tree)
  if (!ancestor) return false
  function hasChild(node: TreeNode): boolean {
    for (const c of node.children) {
      if (c.id === candidateId) return true
      if (hasChild(c)) return true
    }
    return false
  }
  return hasChild(ancestor)
}

/** Get the parent node ID for a given node in the tree */
function getParentId(tree: TreeNode[], targetId: string, parentId: string | null = null): string | null {
  for (const node of tree) {
    if (node.id === targetId) return parentId
    const found = getParentId(node.children, targetId, node.id)
    if (found !== undefined && found !== null) return found
    // Check if found in children (need to handle null return for not-found vs null for root)
    for (const c of node.children) {
      if (c.id === targetId) return node.id
    }
    const deep = getParentId(node.children, targetId, node.id)
    if (deep !== null) return deep
  }
  return null
}

/** Build a flat list of visible node IDs (respecting expanded state) */
function flattenVisible(
  tree: TreeNode[],
  isExpanded: (id: string) => boolean,
): string[] {
  const result: string[] = []
  function walk(nodes: TreeNode[]) {
    for (const node of nodes) {
      result.push(node.id)
      if (node.children.length > 0 && isExpanded(node.id)) {
        walk(node.children)
      }
    }
  }
  walk(tree)
  return result
}

export function useSidebarDrag(
  tree: TreeNode[],
  dimensions: GroupingDimension[],
  isExpanded: (id: string) => boolean,
  expandNode: (id: string) => void,
  onReparent: (entityId: string, entityType: string, newParentId: string | null, newParentType: string | null) => void,
) {
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const autoExpandTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoExpandTarget = useRef<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const edgeScrollRAF = useRef<number | null>(null)

  const clearAutoExpand = useCallback(() => {
    if (autoExpandTimer.current) {
      clearTimeout(autoExpandTimer.current)
      autoExpandTimer.current = null
    }
    autoExpandTarget.current = null
  }, [])

  const handleDragStart = useCallback((nodeId: string, nodeType: string, label: string, clientY: number, clientX: number) => {
    const state: DragState = { nodeId, nodeType, label, startY: clientY, startX: clientX, currentY: clientY }
    dragRef.current = state
    // Don't set visual drag state until threshold is met
  }, [])

  const handleDragMove = useCallback((clientY: number, clientX: number) => {
    const drag = dragRef.current
    if (!drag) return

    const dist = Math.hypot(clientX - drag.startX, clientY - drag.startY)
    if (!dragState && dist < DRAG_THRESHOLD) return

    // Activate visual drag state
    if (!dragState) {
      setDragState({ ...drag, currentY: clientY })
    } else {
      setDragState(prev => prev ? { ...prev, currentY: clientY } : null)
    }
    drag.currentY = clientY

    // Find which node row the cursor is over
    const container = scrollContainerRef.current
    if (!container) return

    const rows = container.querySelectorAll<HTMLElement>('[data-drag-node-id]')
    let target: DropTarget | null = null

    for (const row of rows) {
      const nodeId = row.dataset.dragNodeId!
      if (nodeId === drag.nodeId) continue // skip self
      if (isDescendant(tree, drag.nodeId, nodeId)) continue // skip descendants

      const rect = row.getBoundingClientRect()
      if (clientY < rect.top || clientY > rect.bottom) continue

      // Determine position based on cursor location within the row
      const relY = clientY - rect.top
      const rowHeight = rect.height
      const relX = clientX - rect.left
      const nodeType = row.dataset.dragNodeType!

      // If cursor is horizontally shifted right (indent zone) and node can have children
      if (relX > NEST_INDENT_PX && nodeType !== 'run') {
        target = { nodeId, position: 'inside' }
      } else if (relY < rowHeight * 0.33) {
        target = { nodeId, position: 'before' }
      } else if (relY > rowHeight * 0.67) {
        target = { nodeId, position: 'after' }
      } else if (nodeType !== 'run') {
        target = { nodeId, position: 'inside' }
      } else {
        target = { nodeId, position: 'after' }
      }
      break
    }

    setDropTarget(target)

    // Auto-expand collapsed groups when hovering
    if (target?.position === 'inside' && target.nodeId !== autoExpandTarget.current) {
      clearAutoExpand()
      autoExpandTarget.current = target.nodeId
      autoExpandTimer.current = setTimeout(() => {
        expandNode(target!.nodeId)
      }, AUTO_EXPAND_DELAY)
    } else if (target?.position !== 'inside') {
      clearAutoExpand()
    }

    // Edge scrolling
    if (container) {
      const containerRect = container.getBoundingClientRect()
      const topDist = clientY - containerRect.top
      const bottomDist = containerRect.bottom - clientY

      if (edgeScrollRAF.current) cancelAnimationFrame(edgeScrollRAF.current)

      if (topDist < EDGE_SCROLL_ZONE && topDist > 0) {
        const speed = ((EDGE_SCROLL_ZONE - topDist) / EDGE_SCROLL_ZONE) * EDGE_SCROLL_SPEED
        container.scrollTop -= speed
      } else if (bottomDist < EDGE_SCROLL_ZONE && bottomDist > 0) {
        const speed = ((EDGE_SCROLL_ZONE - bottomDist) / EDGE_SCROLL_ZONE) * EDGE_SCROLL_SPEED
        container.scrollTop += speed
      }
    }
  }, [dragState, tree, clearAutoExpand, expandNode])

  const handleDragEnd = useCallback(() => {
    const drag = dragRef.current
    clearAutoExpand()

    if (drag && dropTarget && dragState) {
      // Parse the dragged node ID to get entity info
      const dragDash = drag.nodeId.indexOf('-')
      const dragType = drag.nodeId.slice(0, dragDash)
      const dragEntityId = drag.nodeId.slice(dragDash + 1)

      // Parse target node ID
      const targetDash = dropTarget.nodeId.indexOf('-')
      const targetType = dropTarget.nodeId.slice(0, targetDash)
      const targetEntityId = dropTarget.nodeId.slice(targetDash + 1)

      if (dropTarget.position === 'inside') {
        // Reparent into target
        onReparent(dragEntityId, dragType, targetEntityId, targetType)
      } else {
        // before/after: reparent to same parent as the target
        const parentId = getParentId(tree, dropTarget.nodeId)
        if (parentId) {
          const parentDash = parentId.indexOf('-')
          const parentType = parentId.slice(0, parentDash)
          const parentEntityId = parentId.slice(parentDash + 1)
          onReparent(dragEntityId, dragType, parentEntityId, parentType)
        } else {
          // Target is at root level — unparent (orphan)
          onReparent(dragEntityId, dragType, null, null)
        }
      }
    }

    dragRef.current = null
    setDragState(null)
    setDropTarget(null)
  }, [dropTarget, dragState, tree, onReparent, clearAutoExpand])

  return {
    dragState,
    dropTarget,
    scrollContainerRef,
    dragInitiated: dragRef,
    handleDragStart,
    handleDragMove,
    handleDragEnd,
  }
}

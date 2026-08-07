import { useRef, useState, useCallback } from 'react'
import type { TreeNode, GroupingDimension } from '../domain/types'

const DRAG_THRESHOLD = 4
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

function findNode(tree: TreeNode[], id: string): TreeNode | null {
  for (const node of tree) {
    if (node.id === id) return node
    const child = findNode(node.children, id)
    if (child) return child
  }
  return null
}

export function useSidebarDrag(
  tree: TreeNode[],
  _dimensions: GroupingDimension[],
  _isExpanded: (id: string) => boolean,
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
    if (nodeType === 'project' || nodeType === 'worktree' || nodeType === 'unscoped') return
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

      const nodeType = row.dataset.dragNodeType!
      if (nodeType === 'project' || nodeType === 'worktree' || nodeType === 'unscoped') {
        target = { nodeId, position: 'inside' }
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
      const draggedNode = findNode(tree, drag.nodeId)
      const targetNode = findNode(tree, dropTarget.nodeId)
      if (draggedNode && targetNode) {
        onReparent(draggedNode.entityId, draggedNode.type, targetNode.entityId || null, targetNode.type)
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

// src/widgets/widgetComponentRegistry.ts
import type React from 'react'
import type { Disposable } from '@tinstar/plugin-api'

export interface GroupWidgetData {
  node: {
    id: string
    label: string
    type: string
    entityId: string
    children: unknown[]
    color?: string
    externalUrl?: string | null
  }
  depth: number
  onShrinkToFit?: (id: string) => void
  onDelete?: (id: string) => void
  onMenuOpen?: (nodeId: string, anchorRect: DOMRect) => void
  onTaskUpdate?: (taskId: string, patch: { externalUrl?: string | null }) => void
}

export interface WidgetProps {
  data: unknown
  zoom: number
  isSelected: boolean
  isDragging: boolean
  isHovered: boolean
  isDropTarget: boolean
}

export interface WidgetFrameState {
  isDragging: boolean
  isSelected: boolean
  isHovered: boolean
  isDropTarget: boolean
}

export interface WidgetRegistration {
  type: string
  component: React.ComponentType<WidgetProps>
  isContainer: boolean
  defaultSize?: { width: number; height: number }
  minSize: { width: number; height: number }
  dragHandleSelector?: string
  getFrameClass?: (state: WidgetFrameState) => string
  supportsMinimize?: boolean
}

const registry = new Map<string, WidgetRegistration>()

export function registerWidgetComponent(reg: WidgetRegistration): Disposable {
  if (registry.has(reg.type)) {
    throw new Error(`Widget type already registered: ${reg.type}`)
  }
  registry.set(reg.type, reg)
  return {
    dispose: () => {
      // Only delete if we're still the registered entry — avoid clobbering a
      // re-registration that happened in between.
      if (registry.get(reg.type) === reg) {
        registry.delete(reg.type)
      }
    },
  }
}

export function getWidgetComponent(type: string): WidgetRegistration | undefined {
  return registry.get(type)
}

/**
 * Maps TreeNode.type values to widget registry type strings.
 * 'run' → 'run-workspace'; all group dimension types map to themselves.
 */
export function toWidgetType(nodeType: string): string {
  if (nodeType === 'run') return 'run-workspace'
  return nodeType
}

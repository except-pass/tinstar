// src/widgets/widgetComponentRegistry.ts
import type {
  WidgetProps as PluginApiWidgetProps,
  WidgetRegistration as PluginApiWidgetRegistration,
  Disposable,
} from '@tinstar/plugin-api'

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

export type WidgetProps = PluginApiWidgetProps
export type { WidgetFrameState } from '@tinstar/plugin-api'

/** Host-internal widget registration. Extends the public shape so any
 * future host-only fields (perf hints, internal frame helpers) can live
 * here without changing the public API. */
export interface WidgetRegistration extends PluginApiWidgetRegistration {
  // V5.0: no internal-only fields.
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

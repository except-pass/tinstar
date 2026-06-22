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

/** Where a registration came from. Plugin widgets register their render
 *  component here too (via createPluginApi().widgets.register), but they are
 *  already surfaced through the manifest-driven plugin registry, so the
 *  host-only catalog accessor must exclude them to avoid double-counting. */
type RegistrationSource = 'host' | 'plugin'

interface StoredRegistration {
  reg: WidgetRegistration
  source: RegistrationSource
}

const registry = new Map<string, StoredRegistration>()

export function registerWidgetComponent(
  reg: WidgetRegistration,
  source: RegistrationSource = 'host',
): Disposable {
  if (registry.has(reg.type)) {
    throw new Error(`Widget type already registered: ${reg.type}`)
  }
  const stored: StoredRegistration = { reg, source }
  registry.set(reg.type, stored)
  return {
    dispose: () => {
      // Only delete if we're still the registered entry — avoid clobbering a
      // re-registration that happened in between.
      if (registry.get(reg.type) === stored) {
        registry.delete(reg.type)
      }
    },
  }
}

export function getWidgetComponent(type: string): WidgetRegistration | undefined {
  return registry.get(type)?.reg
}

/** All currently-registered host widget registrations (snapshot). Used by the
 *  unified widget catalog to surface host widgets (e.g. run-workspace) that are
 *  not part of the plugin registry. Plugin-registered components are excluded —
 *  they are surfaced through the manifest-driven plugin registry instead, so
 *  including them here would double-count spawnable plugin widgets. */
export function listWidgetRegistrations(): WidgetRegistration[] {
  return [...registry.values()].filter((s) => s.source === 'host').map((s) => s.reg)
}

/** The single source of truth for whether a widget participates in snapping.
 *  Non-container leaves snap by default; a widget opts out with `snappable:false`;
 *  containers never snap. FAILS OPEN: an absent registration (e.g. a freshly
 *  spawned widget whose registration hasn't landed yet) is treated as snappable —
 *  callers restrict the set to leaf nodes, so this can't make a container snap. */
export function isSnappable(reg: { isContainer: boolean; snappable?: boolean } | undefined): boolean {
  if (!reg) return true
  return !reg.isContainer && reg.snappable !== false
}

/**
 * Maps TreeNode.type values to widget registry type strings.
 * 'run' → 'run-workspace'; all group dimension types map to themselves.
 */
export function toWidgetType(nodeType: string): string {
  if (nodeType === 'run') return 'run-workspace'
  return nodeType
}

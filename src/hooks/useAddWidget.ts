import { useCallback } from 'react'
import { apiFetch } from '../apiClient'
import { flushPosition } from '../canvas/snapZoneResolver'
import type { SnapEdge } from '../canvas/snapZoneResolver'
import { composeAddWidgetMembership } from '../canvas/addWidgetMembership'
import type { ConstellationGraph } from '../domain/constellationGraph'
import type { AnchorPair } from '../domain/anchors'
import type { CatalogEntry } from './useWidgetCatalog'
import type { WidgetLayout } from './useWidgetLayouts'

// The [+] affordance grows along one edge; express it as the canonical corner
// anchor pair [sourceAnchor, newAnchor] so the persisted attachment matches a
// manual edge-flush snap.
const EDGE_ANCHORS: Record<SnapEdge, AnchorPair> = {
  right:  ['top-right', 'top-left'],
  left:   ['top-left', 'top-right'],
  bottom: ['bottom-left', 'top-left'],
  top:    ['top-left', 'bottom-left'],
}

export interface AddWidgetDeps {
  spaceId: string
  getLayout: (nodeId: string) => WidgetLayout | undefined
  insertLayout: (nodeId: string, layout: WidgetLayout) => void
  /** Atomically update the constellation graph. The compute callback receives the
   *  latest graph (post-async), so membership is planned from current state and
   *  the whole assign+snap change persists as a single revision-gated write. */
  updateConstellation: (compute: (g: ConstellationGraph) => ConstellationGraph) => void
  /** Open the session create flow; resolves with the created sessionId (or null if cancelled). */
  openCreateSession: (prefill: { spaceId: string; view?: string }) => Promise<string | null>
  /** Register a placement to apply once a run with `sessionId` appears via SSE.
   *  `spaceId` is the space active when the add was initiated, so the placement
   *  only applies to that space even if the user navigates away before the run
   *  arrives. */
  registerPendingRunPlacement: (sessionId: string, layout: WidgetLayout, sourceNodeId: string, spaceId: string) => void
}

export function useAddWidget(deps: AddWidgetDeps) {
  const {
    spaceId, getLayout, insertLayout, updateConstellation,
    openCreateSession, registerPendingRunPlacement,
  } = deps

  return useCallback(async (entry: CatalogEntry, sourceNodeId: string, edge: SnapEdge) => {
    const sourceLayout = getLayout(sourceNodeId)
    if (!sourceLayout) return
    const size = entry.defaultSize
    const pos = flushPosition(sourceLayout, edge, size)
    const flushLayout: WidgetLayout = { x: pos.x, y: pos.y, width: size.width, height: size.height }

    // Plan membership from the latest graph at apply time (not a render-time
    // snapshot captured before the create POST), and persist it atomically.
    const applyMembership = (newNodeId: string) =>
      updateConstellation(g => composeAddWidgetMembership(g, sourceNodeId, newNodeId, EDGE_ANCHORS[edge]))

    if (entry.creator === 'session-backed') {
      // A session-backed PLUGIN entry is a session-view: the new run renders it
      // via run.view. The host run-workspace (no pluginId) gets no view (default).
      const view = entry.pluginId ? entry.type : undefined
      const sessionId = await openCreateSession({ spaceId, view })
      if (!sessionId) return
      registerPendingRunPlacement(sessionId, flushLayout, sourceNodeId, spaceId)
      return
    }

    if (entry.pluginId && entry.type !== 'browser-widget') {
      const res = await apiFetch('/api/plugin-widgets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId: entry.pluginId, widgetType: entry.type, spaceId, position: pos, size, data: null }),
      })
      const j = await res.json() as { ok: boolean; data?: { id: string } }
      if (!j.ok || !j.data) return
      insertLayout(j.data.id, flushLayout)
      applyMembership(j.data.id)
      return
    }

    // browser-widget (standalone, no sessionId required)
    const res = await apiFetch('/api/browser-widgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spaceId, position: pos, size }),
    })
    const j = await res.json() as { ok: boolean; data?: { id: string } }
    if (!j.ok || !j.data) return
    insertLayout(j.data.id, flushLayout)
    applyMembership(j.data.id)
  }, [spaceId, getLayout, insertLayout, updateConstellation, openCreateSession, registerPendingRunPlacement])
}

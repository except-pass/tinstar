import { useCallback } from 'react'
import { apiFetch } from '../apiClient'
import { flushPosition } from '../canvas/snapZoneResolver'
import type { SnapEdge } from '../canvas/snapZoneResolver'
import { addWidgetMembership } from '../canvas/addWidgetMembership'
import { nextFreeSlot } from './useConstellationGraph'
import type { ConstellationGraph, ConstellationSlot } from '../domain/constellationGraph'
import type { CatalogEntry } from './useWidgetCatalog'
import type { WidgetLayout } from './useWidgetLayouts'

export interface AddWidgetDeps {
  spaceId: string
  getLayout: (nodeId: string) => WidgetLayout | undefined
  insertLayout: (nodeId: string, layout: WidgetLayout) => void
  graph: ConstellationGraph
  slotsForNode: (nodeId: string) => string[]
  assignSlot: (slot: string, nodeId: string) => void
  addSnapEdge: (a: string, b: string) => void
  /** Open the session create flow; resolves with the created sessionId (or null if cancelled). */
  openCreateSession: (prefill: { spaceId: string }) => Promise<string | null>
  /** Register a placement to apply once a run with `sessionId` appears via SSE. */
  registerPendingRunPlacement: (sessionId: string, layout: WidgetLayout, sourceNodeId: string) => void
}

export function useAddWidget(deps: AddWidgetDeps) {
  const {
    spaceId, getLayout, insertLayout, graph, slotsForNode, assignSlot, addSnapEdge,
    openCreateSession, registerPendingRunPlacement,
  } = deps

  return useCallback(async (entry: CatalogEntry, sourceNodeId: string, edge: SnapEdge) => {
    const sourceLayout = getLayout(sourceNodeId)
    if (!sourceLayout) return
    const size = entry.defaultSize
    const pos = flushPosition(sourceLayout, edge, size)
    const flushLayout: WidgetLayout = { x: pos.x, y: pos.y, width: size.width, height: size.height }

    const applyMembership = (newNodeId: string) => {
      const sourceSlot = (slotsForNode(sourceNodeId)[0] ?? null) as ConstellationSlot | null
      const freeSlot = nextFreeSlot(graph)
      const plan = addWidgetMembership({ sourceSlot, freeSlot, sourceId: sourceNodeId, newId: newNodeId })
      for (const a of plan.assigns) assignSlot(a.slot, a.nodeId)
      if (plan.snap) addSnapEdge(plan.snap.a, plan.snap.b)
    }

    if (entry.creator === 'session-backed') {
      const sessionId = await openCreateSession({ spaceId })
      if (!sessionId) return
      registerPendingRunPlacement(sessionId, flushLayout, sourceNodeId)
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
  }, [spaceId, getLayout, insertLayout, graph, slotsForNode, assignSlot, addSnapEdge, openCreateSession, registerPendingRunPlacement])
}

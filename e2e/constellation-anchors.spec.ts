// Spawn-time anchor attach, end-to-end through the real server.
//
// Proves the headline new API surface: POST /api/browser-widgets with an
// `attach: { to, anchors: "<targetAnchor>/<newAnchor>" }` positions the new
// widget so the two named anchor points coincide, writes a snapped edge that
// carries the anchor pair (canon-ordered with the node ids) into the space's
// constellation graph, and joins/forms the target's slot. Also asserts the
// 400 on an unknown anchor name.
//
// pluginTest is used (sessions enabled → sessionConfig populated) because the
// server resolves the target's layout via lookupNodeLayout(), which reads
// config.ui.layouts['tinstar-layouts-v3-<spaceId>'] — the SSOT that the
// frontend persists into and that the unit suite seeds directly. The plain
// `test` fixture (TINSTAR_NO_SESSIONS=1) has no sessionConfig, so /api/config
// 404s and lookupNodeLayout can't resolve; attach there would never compute a
// position. We seed the target's layout into that SSOT via PATCH /api/config so
// the position math is deterministic (no dependency on the frontend's debounced
// layout flush).
import { pluginTest as test, expect } from './fixtures'

const TARGET = { x: 1000, y: 1000, width: 400, height: 300 }
const NEW_SIZE = { width: 200, height: 150 }

async function getSpaceId(page: import('@playwright/test').Page): Promise<string> {
  const state = await page.request.get('/api/state').then(r => r.json())
  const spaceId: string | undefined = state.activeSpaceId ?? state.spaces?.[0]?.id
  if (!spaceId) throw new Error('no active space in /api/state')
  return spaceId
}

/** Seed `nodeId`'s layout into the SSOT lookupNodeLayout reads (config.ui.layouts
 *  under the space-scoped key), so attach can resolve the target's position. */
async function seedLayout(
  page: import('@playwright/test').Page,
  spaceId: string,
  nodeId: string,
  rect: { x: number; y: number; width: number; height: number },
) {
  const key = `tinstar-layouts-v3-${spaceId}`
  const resp = await page.request.patch('/api/config', {
    data: { ui: { layouts: { [key]: { [nodeId]: rect } } } },
  })
  expect(resp.status(), 'PATCH /api/config (seed layout) must succeed — needs sessionConfig').toBe(200)
}

test.describe('Spawn-time anchor attach', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('attach positions flush + persists an anchor-carrying snap edge', async ({ page }) => {
    const spaceId = await getSpaceId(page)

    // 1) A real target widget at a known position. lookupNodeLayout reads
    //    config.ui.layouts (NOT the widget's own `position` field), so we also
    //    seed the target's layout into that SSOT under the widget's real id.
    const targetResp = await page.request.post('/api/browser-widgets', {
      data: { spaceId, position: { x: TARGET.x, y: TARGET.y }, size: { width: TARGET.width, height: TARGET.height } },
    })
    expect(targetResp.status()).toBe(200)
    const targetId: string = (await targetResp.json()).data.id
    expect(targetId).toBeTruthy()

    // Confirm the target persisted with the requested position + size.
    await expect.poll(async () => {
      const state = await page.request.get('/api/state').then(r => r.json())
      const w = (state.browserWidgets ?? []).find((b: { id: string }) => b.id === targetId)
      return w ? { position: w.position, size: w.size } : null
    }, { timeout: 5000 }).toEqual({ position: { x: TARGET.x, y: TARGET.y }, size: { width: TARGET.width, height: TARGET.height } })

    await seedLayout(page, spaceId, targetId, TARGET)

    // 2) Spawn a new widget attached top-right(target)/top-left(new): the new
    //    widget's top-left coincides with the target's top-right.
    const attachResp = await page.request.post('/api/browser-widgets', {
      data: { spaceId, attach: { to: targetId, anchors: 'top-right/top-left' }, size: NEW_SIZE },
    })
    expect(attachResp.status()).toBe(200)
    const newId: string = (await attachResp.json()).data.id
    expect(newId).toBeTruthy()
    expect(newId).not.toBe(targetId)

    // 3a) New widget persisted flush-right of the target, top-aligned.
    const expectedPos = { x: TARGET.x + TARGET.width, y: TARGET.y } // { x: 1400, y: 1000 }
    await expect.poll(async () => {
      const state = await page.request.get('/api/state').then(r => r.json())
      const w = (state.browserWidgets ?? []).find((b: { id: string }) => b.id === newId)
      return w?.position ?? null
    }, { timeout: 5000 }).toEqual(expectedPos)

    // 3b) The space graph has a snapped edge between target and new carrying the
    //     anchor pair, and both ids share one constellation slot.
    await expect.poll(async () => {
      const state = await page.request.get('/api/state').then(r => r.json())
      const graph = (state.constellationGraphs ?? []).find((g: { spaceId: string }) => g.spaceId === spaceId)
      if (!graph) return null

      // Snapped edge between the two ids, with an anchor pair aligned to node order.
      const edge = (graph.snapped ?? []).find((e: { nodes: [string, string] }) =>
        (e.nodes[0] === targetId && e.nodes[1] === newId) ||
        (e.nodes[0] === newId && e.nodes[1] === targetId),
      ) as { nodes: [string, string]; anchors?: [string, string] } | undefined
      if (!edge || !edge.anchors) return null

      // Map anchors back to (target, new) regardless of canon ordering.
      const targetAnchor = edge.nodes[0] === targetId ? edge.anchors[0] : edge.anchors[1]
      const newAnchor = edge.nodes[0] === targetId ? edge.anchors[1] : edge.anchors[0]

      // Both ids must be members of the same slot.
      const slotsOf = (id: string): string[] =>
        (graph.members ?? []).filter((m: { widget: string }) => m.widget === id).map((m: { slot: string }) => m.slot)
      const targetSlots = slotsOf(targetId)
      const newSlots = slotsOf(newId)
      const sharedSlot = targetSlots.length === 1 && newSlots.length === 1 && targetSlots[0] === newSlots[0]

      return { targetAnchor, newAnchor, sharedSlot }
    }, { timeout: 5000 }).toEqual({ targetAnchor: 'top-right', newAnchor: 'top-left', sharedSlot: true })
  })

  test('rejects an unknown anchor name with 400', async ({ page }) => {
    const spaceId = await getSpaceId(page)

    // Seed a layout so a *valid* attach to this id would resolve — proving the
    // 400 comes from the bad anchor name, not from an unresolved target.
    const targetResp = await page.request.post('/api/browser-widgets', {
      data: { spaceId, position: { x: TARGET.x, y: TARGET.y }, size: { width: TARGET.width, height: TARGET.height } },
    })
    expect(targetResp.status()).toBe(200)
    const targetId: string = (await targetResp.json()).data.id
    await seedLayout(page, spaceId, targetId, TARGET)

    // 'center' is not one of the 8 named anchors → 400 INVALID_PARAMS.
    const badResp = await page.request.post('/api/browser-widgets', {
      data: { spaceId, attach: { to: targetId, anchors: 'center/top-left' } },
    })
    expect(badResp.status()).toBe(400)
    const body = await badResp.json()
    expect(body.ok).toBe(false)
    expect(body.error?.code).toBe('INVALID_PARAMS')
  })
})

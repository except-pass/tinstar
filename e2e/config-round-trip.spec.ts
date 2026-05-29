import { test, expect } from './fixtures'

test('config round-trip — deep-merge preserves siblings across PATCH', async ({ page, serverUrl }) => {
  await page.goto('/')

  // GET current config
  const initial = await page.evaluate(async (url) => {
    const r = await fetch(`${url}/api/config`)
    return r.json()
  }, serverUrl)
  expect(initial.ok).toBe(true)

  const wasCacheHit = initial.data.ui.telemetryPanels.cacheHit as boolean
  const wasCost     = initial.data.ui.telemetryPanels.cost as boolean
  const wasTokens   = initial.data.ui.telemetryPanels.tokens as boolean
  const wasDuty     = initial.data.ui.telemetryPanels.duty as boolean
  const wasTurnLen  = initial.data.ui.telemetryPanels.turnLength as boolean

  // PATCH only cacheHit
  const patchRes = await page.evaluate(async ({ url, next }) => {
    const r = await fetch(`${url}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ui: { telemetryPanels: { cacheHit: next } } }),
    })
    return { status: r.status, body: await r.json() }
  }, { url: serverUrl, next: !wasCacheHit })
  expect(patchRes.status).toBe(200)
  expect(patchRes.body.ok).toBe(true)

  // GET again — verify cacheHit flipped AND siblings preserved (proves deep-merge to disk)
  const after = await page.evaluate(async (url) => {
    const r = await fetch(`${url}/api/config`)
    return r.json()
  }, serverUrl)
  expect(after.data.ui.telemetryPanels.cacheHit).toBe(!wasCacheHit)
  expect(after.data.ui.telemetryPanels.cost).toBe(wasCost)
  expect(after.data.ui.telemetryPanels.tokens).toBe(wasTokens)
  expect(after.data.ui.telemetryPanels.duty).toBe(wasDuty)
  expect(after.data.ui.telemetryPanels.turnLength).toBe(wasTurnLen)

  // Restore original cacheHit value
  const restoreRes = await page.evaluate(async ({ url, original }) => {
    const r = await fetch(`${url}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ui: { telemetryPanels: { cacheHit: original } } }),
    })
    return r.status
  }, { url: serverUrl, original: wasCacheHit })
  expect(restoreRes).toBe(200)
})

test('config PATCH rejects uploadMaxBytes < 1 MB with 400 BAD_VALUE', async ({ page, serverUrl }) => {
  await page.goto('/')

  const bad = await page.evaluate(async (url) => {
    const r = await fetch(`${url}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadMaxBytes: 1024 }),
    })
    return { status: r.status, body: await r.json() }
  }, serverUrl)
  expect(bad.status).toBe(400)
  expect(bad.body.ok).toBe(false)
  expect(bad.body.error.code).toBe('BAD_VALUE')
})

import { test, expect } from './fixtures'

test('server prefs round trip', async ({ page, serverUrl }) => {
  await page.goto('/')

  // GET defaults
  const defaults = await page.evaluate(async (url) => {
    const r = await fetch(`${url}/api/server-prefs`)
    return r.json()
  }, serverUrl)
  expect(defaults.data.uploadMaxBytes).toBe(100 * 1024 * 1024)

  // PUT update
  const updated = await page.evaluate(async (url) => {
    const r = await fetch(`${url}/api/server-prefs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadMaxBytes: 50 * 1024 * 1024 }),
    })
    return r.json()
  }, serverUrl)
  expect(updated.data.uploadMaxBytes).toBe(50 * 1024 * 1024)

  // GET reflects new value
  const after = await page.evaluate(async (url) => {
    const r = await fetch(`${url}/api/server-prefs`)
    return r.json()
  }, serverUrl)
  expect(after.data.uploadMaxBytes).toBe(50 * 1024 * 1024)

  // PUT invalid value rejected with 400
  const bad = await page.evaluate(async (url) => {
    const r = await fetch(`${url}/api/server-prefs`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uploadMaxBytes: 100 }),
    })
    return { status: r.status, body: await r.json() }
  }, serverUrl)
  expect(bad.status).toBe(400)
  expect(bad.body.ok).toBe(false)
})

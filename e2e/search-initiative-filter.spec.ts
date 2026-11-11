import { expect, test, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureId, fixtureQueue, fixtureScene } from '../test-fixtures/reconciliation/scenes'

let server: ChildProcess, root: string, base: string

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tinstar-initiative-search-'))
  await writeFile(join(root, 'config.json'), JSON.stringify({ firstmate: { homes: [] }, reconciliation: { fleet: [] } }))
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = Number(process.env.TINSTAR_SEARCH_TEST_PORT) || (probe.address() as { port: number }).port
  await new Promise<void>(resolve => probe.close(() => resolve()))
  base = `http://127.0.0.1:${port}`
  server = spawn(join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['src/server/standalone.ts', '--port', String(port), '--no-open'], {
    env: { ...process.env, TINSTAR_CONFIG_HOME: root, TINSTAR_STATE_HOME: join(root, 'state'), TINSTAR_NO_SESSIONS: '1', TINSTAR_NO_PORT_FALLBACK: '1', TINSTAR_TELEMETRY: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout?.on('data', data => { output += data.toString() })
  server.stderr?.on('data', data => { output += data.toString() })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/reconciliation/scene`)).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  await writeFile(join(root, 'failed-start.log'), output)
  throw new Error(`Search regression server did not start; logs: ${root}/failed-start.log`)
})
test.afterAll(async () => {
  server?.kill()
  if (server && server.exitCode === null) await new Promise<void>(resolve => server.once('exit', () => resolve()))
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

const ids = (page: Page) => page.locator('.ov-card').evaluateAll(nodes => [...new Set(nodes.map(node => node.getAttribute('data-entity-id')))].sort())
const preferences = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('tinstar.floor.preferences')!))
async function chooseInitiative(page: Page) {
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox', { name: 'Find names, IDs and text' }).fill('tin')
  await page.getByRole('option', { name: /^Tin Star\. Initiative/ }).click()
}

for (const width of [1366, 390]) test(`initiative search and explicit filter edits survive restore and Clear all at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  const scene = fixtureScene()
  for (const id of [1, 4]) scene.cards.find(card => card.id === fixtureId(id))!.source.properties.Initiative = { id: 'initiative', type: 'select', value: 'Tin Star', hasMore: false }
  scene.cards.find(card => card.id === fixtureId(1))!.source.properties.Name!.value = 'Tin Star release coordinator'
  scene.cards.find(card => card.id === fixtureId(2))!.source.properties.Status!.value = 'Waiting For'
  await page.route('**/api/reconciliation/scene*', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: fixtureQueue() } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  await page.goto(base)
  const count = page.locator('.ov-active-heading b')
  await page.getByRole('button', { name: /^Filter Cards: Waiting For,/ }).click()
  await expect.poll(() => ids(page)).toEqual([fixtureId(2), fixtureId(4)])
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').fill('tin')
  await expect(count).toHaveText('1')
  expect((await preferences(page)).search?.facets ?? []).toEqual([])
  await page.getByRole('option', { name: /^Tin Star\. Initiative/ }).click()
  await expect(count).toHaveText('2')
  expect((await preferences(page)).search.facets).toEqual([{ field: 'initiative', value: 'Tin Star' }])
  await expect.poll(() => ids(page)).toEqual([fixtureId(4)])
  for (const name of ['By Machine', 'By Manager', 'By Initiative']) {
    await page.getByRole('button', { name, exact: true }).click()
    await expect(page.getByRole('button', { name: 'Remove Initiative: Tin Star' })).toBeVisible()
    await expect.poll(() => ids(page)).toEqual([fixtureId(4)])
  }
  await page.reload()
  await expect(count).toHaveText('2')
  await expect.poll(() => ids(page)).toEqual([fixtureId(4)])
  await page.getByRole('button', { name: 'Remove Initiative: Tin Star' }).click()
  await expect.poll(() => ids(page)).toEqual([fixtureId(2), fixtureId(4)])
  await chooseInitiative(page)
  await page.getByRole('button', { name: 'Remove Cards: Waiting For' }).click()
  await expect(count).toHaveText('1')
  await expect.poll(() => ids(page)).toEqual([fixtureId(1), fixtureId(4)])
  // This exact reload/remove/select/remove/Clear sequence exposed a capture-
  // phase workspace restore overwriting the user's newer donut-filter action.
  // Explicit filter edits have already ended the initiative session.
  await expect(page.getByRole('button', { name: 'Clear search focus' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Clear all', exact: true }).click()
  await expect(count).toHaveText('0')
  expect((await preferences(page)).donutFilter).toEqual({ cards: [], workers: [] })
  expect((await preferences(page)).search.facets).toEqual([])
  expect((await preferences(page)).organizer.outer).toBe('initiative')
  await page.reload()
  await expect(count).toHaveText('0')

  // Individual card results still reveal outside the applied initiative/status
  // floor. Closing the lens must retain later explicit filter edits.
  await page.getByRole('button', { name: /^Filter Cards: Waiting For,/ }).click()
  await chooseInitiative(page)
  await page.keyboard.press('Control+k')
  await page.getByRole('combobox').fill('Tin Star release coordinator')
  await expect(page.getByRole('option', { name: /Tin Star release coordinator.*Outside current view/ })).toBeVisible()
  await page.getByRole('combobox').press('ArrowDown')
  await page.getByRole('combobox').press('Enter')
  await expect.poll(() => ids(page)).toEqual([fixtureId(1)])
  await page.getByRole('button', { name: 'Remove Initiative: Tin Star' }).click()
  await page.getByRole('button', { name: 'Clear all', exact: true }).click()
  await page.getByRole('button', { name: 'Clear search focus' }).click()
  // Reload left an older session entry in history; the current lens must be gone.
  await expect(page.getByRole('button', { name: 'Clear search focus' })).toHaveCount(0)
  await expect(count).toHaveText('0')
  expect((await preferences(page)).donutFilter).toEqual({ cards: [], workers: [] })
  expect((await preferences(page)).search.facets).toEqual([])
  await expect.poll(() => ids(page)).toContain(fixtureId(2))

  await chooseInitiative(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Clear search focus' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Remove Initiative: Tin Star' })).toBeVisible()
  await page.getByRole('button', { name: 'Remove Initiative: Tin Star' }).click()
  await expect(count).toHaveText('0')
})

test('backend stores waiting-on-main state inside the isolated fixture root', async () => {
  await expect.poll(async () => {
    try {
      return JSON.parse(await readFile(join(root, 'state', 'waiting-on-main.json'), 'utf8'))
    } catch { return null }
  }).toEqual({ initializedAlerts: false, rows: [] })
})

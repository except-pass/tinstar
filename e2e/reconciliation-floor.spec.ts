import { expect, test, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureHomes, fixtureId, fixtureNames, fixtureScene, fixtureSources, fixtureViewerWorkers } from '../test-fixtures/reconciliation/scenes'
import { SceneReconciler } from '../src/server/reconciliation/scene'

async function freePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
let server: ChildProcess
let root: string
let base: string

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tinstar-floor-'))
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'config', 'config.json'), JSON.stringify({ firstmate: { homes: [] }, reconciliation: { fleet: [] } }))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['src/server/standalone.ts', '--port', String(port), '--no-open'], {
    env: { ...process.env, TINSTAR_CONFIG_HOME: join(root, 'config'), TINSTAR_NO_SESSIONS: '1', TINSTAR_TELEMETRY: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout?.on('data', data => { output += data.toString() })
  server.stderr?.on('data', data => { output += data.toString() })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/reconciliation/scene`)).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  await writeFile(join(root, 'failed-start.log'), output)
  throw new Error(`Floor server did not start; logs: ${root}/failed-start.log`)
})
test.afterAll(async () => {
  server?.kill()
  if (server && server.exitCode === null) await new Promise<void>(resolve => server.once('exit', () => resolve()))
  if (root) await rm(root, { recursive: true, force: true })
})
async function screenshot(page: Page, name: string) {
  const directory = process.env.TINSTAR_FLOOR_SCREENSHOTS
  if (directory) await mkdir(directory, { recursive: true })
  await page.screenshot({ path: directory ? join(directory, `${name}.png`) : test.info().outputPath(`${name}.png`), fullPage: true })
}

test('arrangements, missing sides, collapse, inspector, roadmap and read-only keyboard/mobile navigation', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 })
  const scene = fixtureScene()
  const mutations: string[] = []
  page.on('request', request => { if (request.method() !== 'GET') mutations.push(`${request.method()} ${request.url()}`) })
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: fixtureViewerWorkers(), attention: [], errors: [] } } }))
  await page.goto(`${base}/?view=floor`)
  await expect(page.getByRole('heading', { name: 'Reconciliation Floor' })).toBeVisible()
  await expect(page.locator('.floor-coverage')).toContainText('7 cards · 5 unique workers · 5 attempts')
  await expect(page.locator('.floor-socket.floor-gap')).toContainText('Execution gap')
  await expect(page.locator('.floor-socket.floor-untracked')).toContainText('Untracked execution')
  await expect(page.locator('.floor-claim.floor-unknown')).toContainText('inferred')
  await screenshot(page, 'initiative')
  const card = page.locator(`[data-card-id="${fixtureId(1)}"]`)
  await expect(card.locator('.floor-worker')).toHaveCount(2)
  await card.locator('.floor-worker').first().click()
  const viewer = page.getByRole('link', { name: 'Open safe worker / terminal viewer' })
  await expect(viewer).toHaveAttribute('href', '?worker=linked-worker&home=hulk')
  await expect(viewer).toHaveAttribute('target', '_blank')
  await page.getByRole('button', { name: 'Close inspector' }).click()
  await card.locator('.floor-task').click()
  await expect(page.getByLabel('Scene inspector')).toContainText(fixtureNames.linked)
  const selected = await page.locator('.floor-task.is-selected').getAttribute('data-semantic-id')
  for (const name of ['Second Mate', 'Machine', 'Initiative']) {
    await page.getByRole('button', { name, exact: true }).click()
    await expect(page.getByLabel('Scene inspector')).toContainText(fixtureNames.linked)
    expect(await page.locator('.floor-task.is-selected').first().getAttribute('data-semantic-id')).toBe(selected)
    const groups = await page.locator('[data-group-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-group-id')))
    expect(groups.some(id => id?.includes(name === 'Machine' ? 'machine' : name === 'Second Mate' ? 'home' : 'initiative'))).toBe(true)
    await screenshot(page, name === 'Machine' ? 'machine' : name === 'Second Mate' ? 'second-mate' : 'initiative-selected')
  }
  await page.getByRole('button', { name: 'Close inspector' }).click()
  await page.getByRole('button', { name: `Collapse manager ${fixtureHomes[0]}` }).click()
  await expect(page.locator('.floor-manager')).toHaveCount(1)
  await expect(page.locator('.floor-manager-count').first()).toContainText('5 unique workers in subtree')
  await expect(card).toContainText('2 attempt(s) under collapsed managers')
  await expect(card.locator('.floor-worker')).toHaveCount(0)
  await page.getByRole('button', { name: `Expand manager ${fixtureHomes[0]}` }).click()
  await expect(card.locator('.floor-worker')).toHaveCount(2)
  await page.getByRole('button', { name: /^Exceptions Only/ }).click()
  await expect(page.locator(`[data-card-id="${fixtureId(5)}"]`)).toHaveCount(0)
  await expect(page.locator(`[data-card-id="${fixtureId(2)}"]`)).toBeVisible()
  await page.getByRole('button', { name: /^Flash gaps/ }).click()
  await expect(page.locator('.is-flashed')).toHaveCount(2)
  await screenshot(page, 'exceptions')
  await page.getByRole('button', { name: 'Clear highlights', exact: true }).click()
  await expect(page.locator('.is-flashed')).toHaveCount(0)
  await page.getByRole('button', { name: /^Exceptions Only/ }).click()
  await page.getByRole('button', { name: /Roadmap \/ waits/ }).first().click()
  await expect(page.locator(`[data-card-id="${fixtureId(5)}"]`)).toBeVisible()
  await expect(page.locator(`[data-card-id="${fixtureId(4)}"]`)).toContainText('blocked')
  await screenshot(page, 'roadmap')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('button', { name: 'Machine', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Machine', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.floor')).toHaveAttribute('data-arrangement', 'machine')
  await page.locator('.floor-worker').first().click()
  await expect(page.getByLabel('Scene inspector')).toBeVisible()
  await screenshot(page, 'mobile-reduced-motion')
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Scene inspector')).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  expect(mutations).toEqual([])
})

test('large fixture, unavailable home, failed refresh and restart keep identities and uncertainty', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 1050 })
  await page.clock.install()
  let scene = fixtureScene({ size: 850, unavailable: true })
  let failed = false
  await page.route('**/api/reconciliation/scene', route => failed ? route.fulfill({ status: 503, body: 'unavailable' }) : route.fulfill({ json: { ok: true, data: scene } }))
  await page.goto(`${base}/?view=floor`)
  await expect(page.locator('.floor-coverage')).toContainText('857 cards · 85 unique workers')
  await expect(page.locator('.floor-socket.floor-gap')).toHaveCount(0)
  await expect(page.locator('.floor-socket.floor-untracked')).toHaveCount(0)
  await expect(page.locator('.floor-source-warning').filter({ hasText: 'Fixture: home publication unavailable' })).toBeVisible()
  await screenshot(page, 'large-unavailable')
  await page.locator(`[data-card-id="${fixtureId(1)}"] .floor-task`).click()
  failed = true
  await page.clock.fastForward(20_001)
  await expect(page.locator('.floor-coverage')).toContainText('Scene read unavailable')
  await expect(page.getByLabel('Scene inspector')).toContainText(fixtureNames.linked)
  await expect(page.locator('.floor-coverage')).toContainText('857 cards')
  await screenshot(page, 'read-failure-last-known')
  const source = fixtureSources()
  const model = new SceneReconciler()
  const original = model.reconcile(source)
  const oldClaim = original.claims[0]!
  source.fleet[1]!.observation.data!.tasks[0]!.identity.spawn_gen = 'attempt-2'
  source.fleet[1]!.observation.data!.tasks[0]!.cardReferences[0]!.pageId = fixtureId(3)
  scene = model.reconcile(source)
  expect(scene.claimHistory.some(c => c.id === oldClaim.id)).toBe(true)
  failed = false
  await page.clock.fastForward(20_001)
  await expect(page.locator('.floor-coverage')).toContainText('7 cards')
  await expect(page.getByLabel('Scene inspector')).toContainText('attempt-1')
  await expect(page.getByLabel('Scene inspector')).toContainText('historical')
  await page.getByRole('button', { name: 'Machine', exact: true }).click()
  await expect(page.getByLabel('Scene inspector')).toContainText(fixtureNames.linked)
})

import { expect, test, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureId, fixtureNames, fixtureScene, fixtureSources, fixtureViewerWorkers } from '../test-fixtures/reconciliation/scenes'
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

test('independent columns, cross-group relationships, two-sided gaps and one persistent Desk', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const scene = fixtureScene(), mutations: string[] = []
  const { fixtureQueue } = await import('../test-fixtures/reconciliation/scenes')
  page.on('request', req => { if (req.method() !== 'GET' && !req.url().includes('/api/reconciliation/ui')) mutations.push(req.url()) })
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: fixtureQueue() } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: fixtureViewerWorkers(), attention: [], errors: [] } } }))
  await page.goto(base)
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /Needs You|Floor/ })).toHaveCount(0)
  await expect(page.locator('.ov-execution')).toHaveCount(5)
  await expect(page.locator('.ov-card')).toHaveCount(7)
  await page.getByRole('button', { name: 'Links', exact: true }).click()
  await expect(page.locator('.ov-connections')).toHaveCount(0)
  await expect(page.locator('.ov-execution')).toHaveCount(5)
  await expect(page.locator('.ov-card')).toHaveCount(7)
  await page.getByRole('button', { name: 'Links', exact: true }).click()
  const card = page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)
  await card.click()
  await expect(page.locator('.ov-execution.related')).toHaveCount(2)
  for (const name of ['Manager', 'Machine', 'Initiative']) {
    await page.getByRole('button', { name, exact: true }).click()
    await expect(page.getByLabel('Inspector', { exact: true })).toContainText(fixtureNames.linked)
    await expect(page.locator(`.ov-card.selected[data-entity-id="${fixtureId(1)}"]`).first()).toBeVisible()
    if (name !== 'Initiative') await expect(page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)).toHaveCount(2)
  }
  await page.locator('.ov-back').click()
  await page.getByRole('button', { name: 'Next →', exact: true }).click()
  const queueId = await page.getByLabel('Desk queue').getAttribute('data-queue-item-id')
  await card.click()
  await page.locator('.ov-back').click()
  await expect(page.getByLabel('Desk queue')).toHaveAttribute('data-queue-item-id', queueId!)
  await page.getByRole('button', { name: /Gaps only/ }).click()
  await expect(page.locator('.ov-execution.ov-orphan')).toHaveCount(1)
  await expect(page.locator('.ov-card.ov-gap')).toHaveCount(1)
  await page.getByRole('button', { name: /Find gaps/ }).click()
  await expect(page.locator('.ov-item.flashed')).toHaveCount(2)
  await screenshot(page, 'overview-gaps')
  const worker = page.locator('.ov-execution').filter({ hasText: 'linked worker' }).first()
  await worker.click()
  await expect(page.getByRole('link', { name: 'Open worker terminal' })).toHaveAttribute('href', '?worker=linked-worker&home=hulk')
  await page.keyboard.press('Escape')
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Machine', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.ov')).toHaveAttribute('data-arrangement', 'machine')
  await page.locator('.ov-card').first().click()
  await expect(page.getByLabel('Inspector', { exact: true })).toBeVisible()
  const drawer = page.locator('.ov-desk.mobile-open')
  const railBounds = await page.locator('.cockpit-activity').boundingBox()
  const drawerBounds = await drawer.boundingBox()
  expect(drawerBounds!.x).toBeGreaterThanOrEqual(railBounds!.x + railBounds!.width)
  for (const target of [drawer.getByRole('heading', { name: 'Your desk' }), drawer.locator('.ov-back'), drawer.locator('.ov-mobile-close')]) {
    await expect(target).toBeVisible()
    expect(await target.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(bounds.left + 1, bounds.top + bounds.height / 2))
    })).toBe(true)
  }
  await screenshot(page, 'overview-mobile-reduced-motion')
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Inspector', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(mutations).toEqual([])
})

test('realistic volume, last-known data and failed refresh suspend absence findings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install()
  const scene = fixtureScene({ size: 850, unavailable: true })
  let failed = false
  await page.route('**/api/reconciliation/scene', route => failed ? route.fulfill({ status: 503, body: 'unavailable' }) : route.fulfill({ json: { ok: true, data: scene } }))
  await page.goto(base)
  await expect(page.locator('.ov-card')).toHaveCount(857)
  await expect(page.locator('.ov-execution')).toHaveCount(85)
  await expect(page.locator('.ov-item.ov-gap,.ov-item.ov-orphan')).toHaveCount(0)
  await page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`).click()
  failed = true
  await page.clock.fastForward(20_001)
  await expect(page.getByRole('button', { name: 'Notion unavailable · Details' })).toBeVisible()
  await expect(page.locator('.ov-card')).toHaveCount(857)
  await expect(page.getByLabel('Inspector', { exact: true })).toContainText(fixtureNames.linked)
  await screenshot(page, 'overview-large-last-known')
})

for (const state of ['queued', 'held']) {
  test(`explicit ${state} waits remain independently visible without a false gap`, async ({ page }) => {
    const sources = fixtureSources()
    Object.assign(sources.fleet[1]!.observation.data!.backlog![0]!, { state, hold_reason: 'Awaiting review capacity', blocked_by: 'review-task', hold_until: '2026-11-05T12:00:00Z' })
    const scene = new SceneReconciler().reconcile(sources)
    await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
    await page.goto(base)
    const card = page.locator(`.ov-card[data-entity-id="${fixtureId(2)}"]`)
    await expect(card).toHaveAttribute('data-tone', 'quiet')
    await card.click()
    await expect(page.getByLabel('Inspector', { exact: true })).toContainText('Awaiting review capacity')
    await expect(page.getByLabel('Inspector', { exact: true })).toContainText('review-task')
    await expect(page.getByLabel('Inspector', { exact: true })).toContainText('2026-11-05T12:00:00Z')
  })
}

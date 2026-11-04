import { expect, test, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureId, fixtureScene, fixtureSources, fixtureViewerWorkers } from '../test-fixtures/reconciliation/scenes'
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

test('shared task/worker grouping, nested order, filters, references and persistence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const proofNow = Date.parse('2026-11-04T17:00:00Z')
  await page.clock.install({ time: proofNow })
  const sources = fixtureSources({ now: proofNow })
  const cards = sources.intentions.data!.cards
  cards.find(c => c.id === fixtureId(1))!.properties['Next check-in'] = { id: 'check', type: 'date', hasMore: false, value: { start: '2026-11-04T11:00:00-05:00' } }
  cards.find(c => c.id === fixtureId(4))!.properties['Next check-in']!.value = { start: '2026-11-05T12:00:00-05:00' }
  const scene = new SceneReconciler().reconcile(sources, proofNow), mutations: string[] = []
  const { fixtureQueue } = await import('../test-fixtures/reconciliation/scenes')
  page.on('request', req => { if (req.method() !== 'GET' && !req.url().includes('/api/reconciliation/ui')) mutations.push(req.url()) })
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: fixtureQueue() } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: fixtureViewerWorkers(), attention: [], errors: [] } } }))
  await page.goto(base)
  await expect(page.getByLabel('Status preset')).toHaveValue('operational')
  await expect(page.locator('.ov-execution')).toHaveCount(5)
  await expect(page.locator('.ov-card')).toHaveCount(5)
  await expect(page.getByLabel('Fields', { exact: true })).toHaveCount(0)
  const active = page.locator('.ov-group').filter({ has: page.locator('.ov-group-name', { hasText: /^In Progress$/ }) })
  await expect(active.locator('.ov-execution')).toHaveCount(2)
  await expect(active.locator('.ov-card')).toHaveCount(4)
  await page.getByLabel('Outer grouping').selectOption('machine')
  const linked = page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)
  await expect(linked).toHaveCount(2)
  await expect(page.locator('.ov-intro')).toContainText('5 Notion cards')
  for (const machine of ['Bandit', 'Hulk']) {
    const group = page.locator('.ov-group').filter({ has: page.locator('.ov-group-name', { hasText: new RegExp('^' + machine + '$') }) })
    await expect(group.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)).toHaveCount(1)
    await expect(group.locator('.ov-execution')).not.toHaveCount(0)
  }
  await page.getByLabel('Inner grouping').selectOption('status')
  await expect(page.locator('.ov-outer')).toHaveCount(3)
  await expect(linked).toHaveCount(2)
  await page.getByLabel('Outer grouping').selectOption('none')
  await page.getByLabel('Inner grouping').selectOption('none')
  const orderedIds = () => page.locator('.ov-card').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-entity-id')))
  expect((await orderedIds()).slice(0, 2)).toEqual([fixtureId(1), fixtureId(4)])
  await page.getByRole('button', { name: 'Reverse sort direction' }).click()
  expect((await orderedIds()).slice(0, 2)).toEqual([fixtureId(4), fixtureId(1)])
  await page.getByLabel('Outer grouping').selectOption('checkIn')
  await expect(page.locator('.ov-group-name')).toHaveText(['Overdue', 'Tomorrow', 'Not scheduled'])
  await expect(page.locator('.ov-group').filter({ hasText: 'Overdue' }).locator('.ov-execution')).toHaveCount(2)
  await page.getByLabel('Status preset').selectOption('all')
  await expect(page.locator('.ov-card')).toHaveCount(7)
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await page.getByLabel('In Progress', { exact: true }).uncheck()
  await expect(page.getByLabel('Status preset')).toHaveValue('custom')
  await expect(linked).toHaveCount(0)
  await expect(page.locator('.ov-execution')).toHaveCount(5)
  const hiddenWorker = page.locator('.ov-execution').filter({ hasText: 'linked worker' })
  await expect(hiddenWorker).toHaveAttribute('data-tone', 'linked')
  await page.getByRole('button', { name: 'Close filters' }).click()
  await page.reload()
  await expect(page.getByLabel('Status preset')).toHaveValue('custom')
  await expect(page.getByLabel('Outer grouping')).toHaveValue('checkIn')
  await expect(page.locator('.ov')).toHaveAttribute('data-direction', 'desc')
  await expect(linked).toHaveCount(0)
  await expect(page.locator('.ov-execution')).toHaveCount(5)
  await page.getByRole('button', { name: 'Fields', exact: true }).click()
  await page.getByRole('button', { name: 'Worker Machine' }).click()
  await page.getByRole('group', { name: 'Place Machine' }).getByRole('button', { name: 'outer' }).click()
  await expect(page.getByLabel('Outer grouping')).toHaveValue('machine')
  await screenshot(page, 'controlled-shared-floor')
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.getByLabel('Status preset')).toHaveValue('operational')
  await expect(page.getByLabel('Outer grouping')).toHaveValue('status')
  await expect(page.getByLabel('Fields', { exact: true })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.getByLabel('Outer grouping').selectOption('manager')
  await expect(page.locator('.ov-execution')).toHaveCount(5)
  await screenshot(page, 'controlled-shared-floor-mobile')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(mutations).toEqual([])
})

test('date grouping uses all six New York buckets in calendar order', async ({ page }) => {
  const now = Date.parse('2026-11-04T17:00:00Z')
  await page.clock.install({ time: now })
  const scene = fixtureScene({ now })
  const schedule = [
    [1, '2026-11-04T11:00:00-05:00'], [2, '2026-11-05T02:00:00Z'],
    [3, '2026-11-05'], [4, '2026-11-08'], [6, '2026-11-09'],
  ] as const
  for (const [id, start] of schedule) scene.cards.find(c => c.id === fixtureId(id))!.source.properties['Next check-in'] = { id: 'check', type: 'date', hasMore: false, value: { start } }
  scene.cards.find(c => c.id === fixtureId(100))!.source.properties.Status!.value = 'Queued'
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.goto(base)
  await page.getByLabel('Outer grouping').selectOption('checkIn')
  await expect(page.locator('.ov-group-name')).toHaveText(['Overdue', 'Today', 'Tomorrow', 'This week', 'Later', 'Not scheduled'])
  await expect(page.locator('.ov-group').filter({ has: page.locator('.ov-group-name', { hasText: /^Today$/ }) }).locator(`.ov-card[data-entity-id="${fixtureId(2)}"]`)).toBeVisible()
})

test('realistic volume, last-known data and failed refresh suspend absence findings', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.clock.install()
  const scene = fixtureScene({ size: 850, unavailable: true })
  let failed = false
  await page.route('**/api/reconciliation/scene', route => failed ? route.fulfill({ status: 503, body: 'unavailable' }) : route.fulfill({ json: { ok: true, data: scene } }))
  await page.goto(base)
  await page.getByLabel('Status preset').selectOption('all')
  await expect(page.locator('.ov-card')).toHaveCount(857)
  await expect(page.locator('.ov-execution')).toHaveCount(85)
  await expect(page.locator('.ov-item.ov-gap,.ov-item.ov-orphan')).toHaveCount(0)
  await page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`).click()
  failed = true
  await page.clock.fastForward(20_001)
  await expect(page.getByRole('button', { name: 'Notion unavailable · Details' })).toBeVisible()
  await expect(page.locator('.ov-card')).toHaveCount(857)
  await expect(page.getByLabel('Inspector', { exact: true })).toContainText('Build live reconciliation')
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

test('stable task-only metadata and independent worker status, freshness and Inspector', async ({ page }) => {
  const now = Date.parse('2026-11-04T17:00:00Z')
  await page.clock.install({ time: now })
  const scene = fixtureScene({ now })
  const workers = scene.executions.filter(e => e.kind !== 'secondmate')
  workers[0]!.liveness = 'running'
  workers[1]!.liveness = 'waiting'; workers[1]!.source.current_state.state = 'waiting'
  workers[2]!.liveness = 'liveness-not-observed'; workers[2]!.source.current_state.state = 'unknown'
  const card = scene.cards.find(c => c.id === fixtureId(1))!
  for (const [name, value] of Object.entries({ Priority: 'High', 'Last touched by': 'Will', 'Due Date': { start: '2026-11-07' }, 'Next check-in': { start: '2026-11-04T10:00:00-05:00' } })) card.source.properties[name] = { id: name, type: 'rich_text', hasMore: false, value }
  const { fixtureQueue } = await import('../test-fixtures/reconciliation/scenes')
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: fixtureQueue(now) } }))
  await page.route('**/api/reconciliation/card-context?*', route => route.fulfill({ json: { ok: true, data: { outcome: 'available', blocks: [{ id: 'full', text: 'Full source card body' }] } } }))
  await page.goto(base)
  await expect(page.locator('.ov-worker-status').filter({ hasText: /^Running$/ })).not.toHaveCount(0)
  for (const status of ['Waiting', 'Blocked', 'Unknown']) await expect(page.locator('.ov-worker-status').filter({ hasText: new RegExp('^' + status + '$') })).toHaveCount(1)
  const task = page.locator(`.ov-card[data-entity-id="${card.id}"]`).first()
  const fields = await task.locator('.ov-field-label').allTextContents()
  expect(fields).toEqual(['Status', 'Owner', 'Next check-in', 'Last edited', 'Last touched by', 'Priority', 'Due Date'])
  await expect(task).toContainText('Overdue')
  await expect(task).toContainText('Will')
  await expect(task).not.toContainText(/No worker|Unverified|Machine|Manager|Link|execution/i)
  await expect(task.locator('.ov-breadcrumb')).toHaveText('Unassigned')
  const desk = page.getByRole('complementary', { name: 'Your desk' })
  const queueId = await desk.locator('.ov-queue').getAttribute('data-queue-item-id')
  await task.click()
  await expect(page.getByLabel('Inspector', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Inspector', { exact: true })).toContainText('Full source card body')
  await expect(desk.getByLabel('Desk queue')).toBeVisible()
  await expect(desk.locator('.ov-queue')).toHaveAttribute('data-queue-item-id', queueId!)
  const running = page.locator('.ov-execution').filter({ has: page.locator('.status-running') }).first()
  await expect(running).toHaveCSS('opacity', '1')
  await page.getByRole('button', { name: 'Close Inspector' }).click()
  await expect(task).toBeFocused()
  await page.getByLabel('Outer grouping').selectOption('machine')
  expect(await task.locator('.ov-field-label').allTextContents()).toEqual(fields)
  // Expire the observations, preserving recorded execution status and legibility.
  await page.clock.fastForward(61_001)
  await expect(running.locator('.status-running')).toBeVisible()
  await expect(running.locator('.ov-freshness')).toHaveText('Last known observation')
  await running.click()
  await expect(page.getByLabel('Inspector', { exact: true })).toContainText('Latest activity')
  await expect(desk.getByLabel('Desk queue')).toBeVisible()
  await expect(running).toHaveCSS('opacity', '1')
  await page.keyboard.press('Escape')
  await expect(page.getByLabel('Inspector', { exact: true })).toHaveCount(0)
})

for (const mobile of [false, true]) test(`Desk navigates hidden task through collapsed groups, preserves queue and filters (${mobile ? 'mobile reduced motion' : 'desktop'})`, async ({ page }) => {
  const now = Date.parse('2026-11-04T17:00:00Z')
  await page.clock.install({ time: now })
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 })
  if (mobile) await page.emulateMedia({ reducedMotion: 'reduce' })
  const scene = fixtureScene({ now, size: 120 }), mutations: string[] = []
  const { fixtureQueue } = await import('../test-fixtures/reconciliation/scenes')
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: fixtureQueue(now) } }))
  page.on('request', req => { if (req.method() !== 'GET' && !req.url().includes('/api/reconciliation/ui')) mutations.push(req.url()) })
  await page.goto(base)
  await page.getByLabel('Outer grouping').selectOption('machine')
  await page.getByLabel('Inner grouping').selectOption('status')
  const task = page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)
  await expect(task).toHaveCount(2)
  await page.getByRole('button', { name: 'Collapse In Progress', exact: true }).first().click()
  await page.getByRole('button', { name: 'Collapse Bandit', exact: true }).click()
  await page.getByRole('button', { name: 'Collapse Hulk', exact: true }).click()
  await page.getByRole('button', { name: 'Filters', exact: true }).click()
  await page.getByLabel('In Progress', { exact: true }).uncheck()
  await page.getByRole('button', { name: 'Close filters' }).click()
  await expect(task).toHaveCount(0)
  const saved = await page.evaluate(() => localStorage.getItem('tinstar.floor.preferences'))
  await page.locator('.ov-workspace').evaluate(el => { el.scrollTop = el.scrollHeight })
  if (mobile) await page.locator('.ov-mobile-desk').click()
  const desk = page.getByRole('complementary', { name: 'Your desk', includeHidden: true })
  const queueId = await desk.locator('.ov-queue').getAttribute('data-queue-item-id')
  const deskCard = desk.locator(`[data-desk-card-id="${fixtureId(1)}"]`).first()
  await deskCard.focus()
  await page.keyboard.press('Enter')
  await expect(task).toHaveCount(2)
  await expect(task.first()).toBeFocused()
  await expect(task.first()).toHaveClass(/desk-target/)
  await expect(task.first()).toHaveClass(/flashed/)
  await expect(page.getByLabel('Inspector', { exact: true })).toHaveCount(0)
  await expect(desk.locator('.ov-queue')).toHaveAttribute('data-queue-item-id', queueId!)
  await expect(page.locator('.ov-line.desk-target')).toHaveCount(2)
  await expect(page.locator('.ov-execution.desk-target')).toHaveCount(2)
  await expect(page.getByLabel('Status preset')).toHaveValue('custom')
  expect(await page.evaluate(() => localStorage.getItem('tinstar.floor.preferences'))).toBe(saved)
  await page.clock.fastForward(2000)
  await expect(task.first()).not.toHaveClass(/flashed/)
  await expect(task.first()).toHaveClass(/desk-target/)
  expect(await task.first().evaluate(el => { const box = el.getBoundingClientRect(); const root = el.closest('.ov-workspace')!.getBoundingClientRect(); return box.top >= root.top && box.top < root.bottom })).toBe(true)
  await screenshot(page, mobile ? 'desk-navigation-mobile' : 'desk-navigation-desktop')
  await page.reload()
  await expect(task).toHaveCount(0)
  expect(mutations).toEqual([])
})

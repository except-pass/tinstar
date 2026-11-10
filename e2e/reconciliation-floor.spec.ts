import { expect, test, type Page, type Locator } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { fixtureId, fixtureReadinessScene, fixtureScene, fixtureSources, fixtureViewerWorkers } from '../test-fixtures/reconciliation/scenes'
import { SceneReconciler } from '../src/server/reconciliation/scene'
import type { FloorScene } from '../src/shared/reconciliationPresentation'

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


async function inspectEntity(page: Page, entity: Locator) {
  await page.locator('.ov-item-frame').filter({ has: entity }).first().getByRole('button', { name: 'Open in Inspector', exact: true }).click()
}

async function openCustomize(page: Page) {
  const button = page.getByRole('button', { name: 'Customize', exact: true })
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click()
}
async function closeCustomize(page: Page) {
  const button = page.getByRole('button', { name: 'Customize', exact: true })
  if (await button.getAttribute('aria-expanded') === 'true') await button.click()
}
async function selectAdvanced(page: Page, label: string, value: string) {
  await openCustomize(page)
  await page.getByLabel(label, { exact: true }).selectOption(value)
  await closeCustomize(page)
}
async function expectAdvanced(page: Page, label: string, value: string) {
  await openCustomize(page)
  await expect(page.getByLabel(label, { exact: true })).toHaveValue(value)
  await closeCustomize(page)
}
async function clickAdvanced(page: Page, name: string, keepOpen = false) {
  await openCustomize(page)
  await page.getByRole('button', { name, exact: true }).click()
  if (!keepOpen) await closeCustomize(page)
}

/** Use an actual point on the visible stroke. A path's box center may be the
 * donut hole; hit-testing first also detects decorative overlays stealing input. */
async function clickStatusSlice(page: Page, name: string) {
  const slice = page.getByRole('button', { name, exact: true })
  await slice.scrollIntoViewIfNeeded()
  const point = await slice.evaluate(element => {
    const path = element as SVGPathElement
    const midpoint = path.getPointAtLength(path.getTotalLength() / 2)
    const screen = midpoint.matrixTransform(path.getScreenCTM()!)
    const hit = document.elementFromPoint(screen.x, screen.y)
    return { x: screen.x, y: screen.y, hitsSlice: hit === path || !!hit && path.contains(hit), covering: hit?.outerHTML.slice(0, 300) }
  })
  expect(point.hitsSlice, `Slice midpoint covered by ${point.covering}`).toBe(true)
  await page.mouse.click(point.x, point.y)
}
async function tabToStatusSlice(page: Page, name: string) {
  const slice = page.getByRole('button', { name, exact: true })
  // Start from the preceding native control and traverse the real tab order.
  await page.getByRole('button', { name: 'Customize', exact: true }).focus()
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press('Tab')
    if (await slice.evaluate(element => element === document.activeElement)) break
  }
  await expect(slice).toBeFocused()
  return slice
}

// These regressions exercise the preserved rich presentation.
test.beforeEach(async ({ page }, info) => {
  if (info.title.startsWith('single-row toolbar')) return
  await page.addInitScript(() => { if (!localStorage.getItem('tinstar.overview.density')) localStorage.setItem('tinstar.overview.density', 'detailed'); if (!localStorage.getItem('tinstar.floor.preferences')) localStorage.setItem('tinstar.floor.preferences', JSON.stringify({ organizer: { outer: 'initiative', inner: 'status', order: 'checkIn', direction: 'asc' } })) })
})

test.beforeAll(async () => {
  await mkdir(join(process.cwd(), '.test-runtime'), { recursive: true })
  root = await mkdtemp(join(process.cwd(), '.test-runtime', 'tinstar-floor-'))
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'config', 'config.json'), JSON.stringify({ firstmate: { homes: [] }, reconciliation: { fleet: [] } }))
  const port = await freePort()
  base = `http://127.0.0.1:${port}`
  server = spawn(join(process.cwd(), 'node_modules', '.bin', 'tsx'), ['src/server/standalone.ts', '--port', String(port), '--no-open'], {
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, 'config'), TINSTAR_CONFIG_HOME: join(root, 'config'), TINSTAR_NO_SESSIONS: '1', TINSTAR_TELEMETRY: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
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
  await expectAdvanced(page, 'Outer grouping', 'initiative')
  await expectAdvanced(page, 'Inner grouping', 'status')
  await expectAdvanced(page, 'Status preset', 'operational')
  await expect(page.locator('.ov-execution')).toHaveCount(5)
  await expect(page.locator('.ov-card')).toHaveCount(5)
  await expect(page.getByLabel('Fields', { exact: true })).toHaveCount(0)
  const active = page.locator('.ov-group').filter({ has: page.locator('.ov-group-name', { hasText: /^In Progress$/ }) })
  await expect(active.locator('.ov-execution')).toHaveCount(2)
  await expect(active.locator('.ov-card')).toHaveCount(4)
  await selectAdvanced(page, 'Inner grouping', 'none')
  await selectAdvanced(page, 'Outer grouping', 'machine')
  const linked = page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)
  await expect(linked).toHaveCount(2)
  await expect(page.locator('.ov-headings')).toContainText('NOTION TASKS · 5')
  for (const machine of ['Bandit', 'Hulk']) {
    const group = page.locator('.ov-group').filter({ has: page.locator('.ov-group-name', { hasText: new RegExp('^' + machine + '$') }) })
    await expect(group.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)).toHaveCount(1)
    await expect(group.locator('.ov-execution')).not.toHaveCount(0)
  }
  await selectAdvanced(page, 'Inner grouping', 'status')
  await expect(page.locator('.ov-outer')).toHaveCount(3)
  await expect(linked).toHaveCount(2)
  await selectAdvanced(page, 'Outer grouping', 'none')
  await selectAdvanced(page, 'Inner grouping', 'none')
  const orderedIds = () => page.locator('.ov-card').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-entity-id')))
  expect((await orderedIds()).slice(0, 2)).toEqual([fixtureId(1), fixtureId(4)])
  await clickAdvanced(page, 'Reverse sort direction')
  expect((await orderedIds()).slice(0, 2)).toEqual([fixtureId(4), fixtureId(1)])
  await selectAdvanced(page, 'Outer grouping', 'checkIn')
  await expect(page.locator('.ov-group-name')).toHaveText(['Overdue', 'Tomorrow', 'Not scheduled'])
  await expect(page.locator('.ov-group').filter({ hasText: 'Overdue' }).locator('.ov-execution')).toHaveCount(2)
  await selectAdvanced(page, 'Status preset', 'all')
  await expect(page.locator('.ov-card')).toHaveCount(7)
  await clickAdvanced(page, 'Filters', true)
  await page.getByLabel('In Progress', { exact: true }).uncheck()
  await expectAdvanced(page, 'Status preset', 'custom')
  await expect(linked).toHaveCount(0)
  await expect(page.locator('.ov-execution')).toHaveCount(5)
  const hiddenWorker = page.locator('.ov-execution').filter({ hasText: 'linked worker' })
  await expect(hiddenWorker).toHaveAttribute('data-tone', 'linked')
  await clickAdvanced(page, 'Close filters')
  await page.reload()
  await expectAdvanced(page, 'Status preset', 'custom')
  await expectAdvanced(page, 'Outer grouping', 'checkIn')
  await expect(page.locator('.ov')).toHaveAttribute('data-direction', 'desc')
  const candidate = page.locator('.ov-execution').filter({ hasText: 'Candidate relationship' })
  await expect(page.locator('.ov-pair').filter({ has: candidate }).locator('.ov-empty-col')).toHaveText('Task link unverified')
  await expect(page.locator('.ov-pair').filter({ has: candidate }).locator('.ov-gutter')).toHaveText('unverified')
  await expect(linked).toHaveCount(0)
  await expect(page.locator('.ov-execution')).toHaveCount(5)
  await clickAdvanced(page, 'Fields', true)
  await page.getByRole('button', { name: 'Worker Machine' }).click()
  await page.getByRole('group', { name: 'Place Machine' }).getByRole('button', { name: 'outer' }).click()
  await closeCustomize(page)
  await expectAdvanced(page, 'Outer grouping', 'machine')
  await screenshot(page, 'controlled-shared-floor')
  await clickAdvanced(page, 'Reset')
  await expectAdvanced(page, 'Status preset', 'operational')
  await expectAdvanced(page, 'Outer grouping', 'initiative')
  await expectAdvanced(page, 'Inner grouping', 'manager')
  await expect(page.getByLabel('Fields', { exact: true })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await selectAdvanced(page, 'Outer grouping', 'manager')
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
  await selectAdvanced(page, 'Outer grouping', 'checkIn')
  await selectAdvanced(page, 'Inner grouping', 'none')
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
  await selectAdvanced(page, 'Status preset', 'all')
  await expect(page.locator('.ov-card')).toHaveCount(857)
  await expect(page.locator('.ov-execution')).toHaveCount(85)
  await expect(page.locator('.ov-item.ov-gap,.ov-item.ov-orphan')).toHaveCount(0)
  await inspectEntity(page, page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`))
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
    await inspectEntity(page, card)
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
  workers[2]!.liveness = 'liveness-not-observed'; workers[2]!.source.current_state.state = 'unknown'; workers[2]!.source.last_event.state = 'unknown'
  const card = scene.cards.find(c => c.id === fixtureId(1))!
  for (const [name, value] of Object.entries({ Priority: '🔴 High', 'Last touched by': 'Will', 'Due Date': { start: '2026-11-07' }, 'Next check-in': { start: '2026-11-04T10:00:00-05:00' } })) card.source.properties[name] = { id: name, type: 'rich_text', hasMore: false, value }
  const { fixtureQueue } = await import('../test-fixtures/reconciliation/scenes')
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: fixtureQueue(now) } }))
  await page.route('**/api/reconciliation/card-context?*', route => route.fulfill({ json: { ok: true, data: { outcome: 'partial', blocks: [{ id: 'full', text: 'Full source card body' }] } } }))
  await page.goto(base)
  await expect(page.locator('.ov-worker-status').filter({ hasText: /^Running$/ })).not.toHaveCount(0)
  for (const status of ['Waiting', 'Blocked', 'Unknown']) await expect(page.locator('.ov-worker-status').filter({ hasText: new RegExp('^' + status + '$') })).toHaveCount(1)
  const task = page.locator(`.ov-card[data-entity-id="${card.id}"]`).first()
  const fields = await task.locator('.ov-record-top,.ov-task-meta,.ov-record-foot,.ov-context-field').allTextContents()
  await expect(task.locator('.ov-priority')).toHaveText('High')
  await expect(task.locator('.ov-task-status')).toHaveText('In Progress')
  await expect(task).toContainText('Overdue')
  await expect(task.locator('.ov-age')).toHaveAttribute('title', 'Last touched by Will')
  await expect(task).not.toContainText(/No worker|Unverified|Machine|Manager|Link|execution/i)
  await expect(task.locator('.ov-breadcrumb')).toHaveText('Unassigned')
  const desk = page.getByRole('complementary', { name: 'Your desk' })
  const queueId = await desk.locator('.ov-queue').getAttribute('data-queue-item-id')
  await inspectEntity(page, task)
  await expect(page.getByLabel('Inspector', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Inspector', { exact: true })).toContainText('Full source card body')
  await expect(page.getByLabel('Inspector', { exact: true })).toContainText('Last touched byWill')
  await expect(page.getByLabel('Inspector', { exact: true })).toContainText('Some content omitted')
  await expect(desk.getByLabel('Desk queue')).toBeVisible()
  await expect(desk.locator('.ov-queue')).toHaveAttribute('data-queue-item-id', queueId!)
  const running = page.locator('.ov-execution').filter({ has: page.locator('.status-running') }).first()
  await expect(running).toHaveCSS('opacity', '1')
  await page.getByRole('button', { name: 'Close Inspector' }).click()
  await expect(task).toBeFocused()
  await selectAdvanced(page, 'Outer grouping', 'machine')
  expect(await task.locator('.ov-record-top,.ov-task-meta,.ov-record-foot,.ov-context-field').allTextContents()).toEqual(fields)
  // Expire the observations, preserving recorded execution status and legibility.
  await page.clock.fastForward(61_001)
  await expect(running.locator('.status-running')).toBeVisible()
  await expect(running.locator('.ov-freshness')).toHaveAttribute('aria-label', 'Last known observation')
  await inspectEntity(page, running)
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
  await selectAdvanced(page, 'Outer grouping', 'machine')
  await selectAdvanced(page, 'Inner grouping', 'status')
  const task = page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)
  await expect(task).toHaveCount(2)
  await page.getByRole('button', { name: 'Collapse In Progress', exact: true }).first().click()
  await page.getByRole('button', { name: 'Collapse Bandit', exact: true }).click()
  await page.getByRole('button', { name: 'Collapse Hulk', exact: true }).click()
  await clickAdvanced(page, 'Filters', true)
  await page.getByLabel('In Progress', { exact: true }).uncheck()
  await clickAdvanced(page, 'Close filters')
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
  await expectAdvanced(page, 'Status preset', 'custom')
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


test('Coming up card removed by scene refresh links its own source without writes', async ({ page }) => {
  const now = Date.parse('2026-11-04T17:00:00Z')
  await page.clock.install({ time: now })
  const scene = fixtureScene({ now })
  const { fixtureQueue } = await import('../test-fixtures/reconciliation/scenes')
  const mutations: string[] = []
  page.on('request', req => { if (req.method() !== 'GET' && !req.url().includes('/api/reconciliation/ui')) mutations.push(req.url()) })
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: fixtureQueue(now) } }))
  await page.goto(base)
  const desk = page.getByLabel('Desk queue')
  await expect(desk.getByRole('heading', { name: 'Coming up' })).toBeVisible()
  const next = desk.locator('h4').filter({ hasText: 'Coming up' }).locator('xpath=following-sibling::div').first().locator('[data-desk-card-id]')
  const id = await next.getAttribute('data-desk-card-id')
  expect(id).toBeTruthy()
  const queueId = await desk.getAttribute('data-queue-item-id')
  scene.cards = scene.cards.filter(card => card.id !== id)
  await page.clock.fastForward(20_001)
  await expect(page.locator(`.ov-card[data-entity-id="${id}"]`)).toHaveCount(0)
  await next.click()
  const notice = desk.getByRole('status')
  await expect(notice).toContainText('not on the floor right now')
  await expect(notice.getByRole('link', { name: 'Read source card' })).toHaveAttribute('href', `https://www.notion.so/${id}`)
  await expect(desk).toHaveAttribute('data-queue-item-id', queueId!)
  await expect(page.getByLabel('Inspector', { exact: true })).toHaveCount(0)
  expect(mutations).toEqual([])
})

test('approved floor structure: select breadcrumbs, band counts, card positions and per-record gaps', async ({ page }) => {
  await page.setViewportSize({ width: 1396, height: 1039 })
  const now = Date.parse('2026-11-04T17:00:00Z')
  await page.clock.install({ time: now })
  const sources = fixtureSources({ now })
  // Exercise a genuinely independent worker for the empty-task placeholder;
  // positive legacy references now correctly produce an unverified candidate.
  sources.fleet[1]!.observation.data!.tasks.find(task => task.identity.task_id === 'untracked-worker')!.cardReferences = []
  const scene = new SceneReconciler().reconcile(sources, now)
  for (const card of scene.cards) {
    card.source.properties.Initiative = { id: 'initiative', type: 'select', hasMore: false, value: 'Delivery' }
    card.source.properties.Epic = { id: 'epic', type: 'select', hasMore: false, value: 'Readability' }
    card.source.properties.Priority = { id: 'priority', type: 'select', hasMore: false, value: 'High' }
  }
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.goto(base)
  await selectAdvanced(page, 'Outer grouping', 'initiative')
  await selectAdvanced(page, 'Inner grouping', 'status')
  await expect(page.locator('.ov-headings')).toHaveText('WORKERS · 5RELATIONSHIPSNOTION TASKS · 5')
  const outer = page.locator('.ov-outer').filter({ has: page.locator('.ov-group-field', { hasText: 'Initiative' }) }).first()
  await expect(outer.locator(':scope > header')).toContainText('Delivery')
  await expect(outer.locator(':scope > header')).toContainText(/\d+ workers · \d+ tasks/)
  for (const header of await page.locator('.ov-group > header').all()) await expect(header).toContainText(/\d+ W · \d+ T/)
  const task = page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)
  await expect(task.locator('.ov-breadcrumb')).toHaveText('Delivery / Readability')
  const worker = page.locator('.ov-execution').filter({ hasText: 'linked worker' }).first()
  await expect(worker.locator('.ov-breadcrumb')).toHaveText('Delivery / Readability')
  const rect = async (locator: import('@playwright/test').Locator) => (await locator.boundingBox())!
  const crumb = await rect(task.locator('.ov-breadcrumb')), priority = await rect(task.locator('.ov-priority'))
  const title = await rect(task.locator('strong')), meta = await rect(task.locator('.ov-task-meta')), foot = await rect(task.locator('.ov-record-foot'))
  expect(Math.abs(crumb.y - priority.y)).toBeLessThan(5)
  expect(priority.x).toBeGreaterThan(crumb.x)
  expect(title.y).toBeGreaterThan(crumb.y)
  expect(meta.y).toBeGreaterThan(title.y)
  expect(foot.y).toBeGreaterThan(meta.y)
  const status = await rect(worker.locator('.ov-worker-status')), avatar = await rect(worker.locator('.ov-face'))
  expect(status.x).toBeGreaterThan(avatar.x + avatar.width)
  expect((await rect(worker.locator('.ov-record-foot'))).y).toBeGreaterThan((await rect(worker.locator('.ov-worker-meta'))).y)
  await expect(page.getByText('No linked worker', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('No linked task', { exact: true }).first()).toBeVisible()
  await expect(page.locator('.ov-gutter').filter({ hasText: /^no worker$/ }).first()).toBeVisible()
  await expect(page.locator('.ov-gutter').filter({ hasText: /^no task$/ }).first()).toBeVisible()
  for (const placeholder of await page.locator('.ov-empty-col').all()) {
    await expect(placeholder).toHaveCSS('border-top-style', 'dashed')
    expect((await rect(placeholder)).height).toBeGreaterThanOrEqual(108)
  }
  await expect(task).toHaveCount(1)
  const band = outer.locator('.ov-group').filter({ has: page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`) })
  await expect(band).toHaveCount(1)
  const linkedWorkers = ['linked-worker', 'helper-worker'].map(id => scene.executions.find(execution => execution.identity.task_id === id)!)
  for (const execution of linkedWorkers) {
    const endpoint = band.locator(`.ov-execution[data-entity-id=${JSON.stringify(execution.id)}]`)
    await expect(endpoint).toHaveCount(1)
    await endpoint.hover()
    await expect(band.locator('.ov-line.hot.ov-linked')).toHaveCount(1)
  }
  await task.hover()
  await expect(band.locator('.ov-execution.related')).toHaveCount(2)
  await expect(band.locator('.ov-line.hot.ov-linked')).toHaveCount(2)
  await outer.locator(':scope > header > button').click()
  await expect(task).toHaveCount(0)
  await outer.locator(':scope > header > button').click()
  await expect(task).toHaveCount(1)
  await screenshot(page, 'approved-floor-structure')
})


test('worker Order drives task barycenters with many-to-many relationships in both directions', async ({ page }) => {
  const now = Date.parse('2026-11-04T17:00:00Z')
  await page.clock.install({ time: now })
  const scene = fixtureScene({ now })
  const first = scene.claims.find(c => c.cardId === fixtureId(1))!
  scene.claims.push({ ...first, id: 'additional-task', cardId: fixtureId(6) })
  for (const [id, hour] of [[1, 12], [4, 13], [6, 14]]) scene.cards.find(c => c.id === fixtureId(id!))!.source.properties['Next check-in'] = { id: 'check', type: 'date', hasMore: false, value: { start: `2026-11-04T${hour}:00:00Z` } }
  scene.executions.find(w => w.identity.task_id === 'untracked-worker')!.source.last_event.age_seconds = 0
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.goto(base)
  await selectAdvanced(page, 'Outer grouping', 'none')
  await selectAdvanced(page, 'Inner grouping', 'none')
  const { organizedGroups } = await import('../src/shared/floorOrganization')
  const { initialPresentation } = await import('../src/reconciliation/presentation')
  for (const order of ['activity', 'checkIn'] as const) {
    await selectAdvanced(page, 'Order by', order)
    for (const direction of ['asc', 'desc'] as const) {
      const desired = organizedGroups(scene, { ...initialPresentation(), organizer: { outer: 'none', inner: 'none', order, direction } }, now)[0]!
      await expect(page.locator('.ov')).toHaveAttribute('data-direction', direction)
      expect(await page.locator('.ov-execution').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-entity-id')))).toEqual(desired.workers.map(w => w.id))
      // Fixture: tasks 1 and 6 share a worker; task 1 also has a helper.
      // Unlinked tasks 2 and 3 follow the linked endpoints.
      const expectedTasks = order === 'activity' ? [4, 1, 6, 2, 3] : direction === 'asc' ? [1, 6, 4, 2, 3] : [6, 4, 1, 2, 3]
      expect(await page.locator('.ov-card').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-entity-id')))).toEqual(expectedTasks.map(fixtureId))
      await clickAdvanced(page, 'Reverse sort direction')
    }
  }
  await screenshot(page, 'independent-endpoint-order')
})

test('Notion declarations draw confirmed edges without worker-side assignment metadata', async ({ page }) => {
  const now = Date.now(), input = fixtureSources({ now })
  for (const home of input.fleet) for (const task of home.observation.data!.tasks) task.cardReferences = []
  const scene = new SceneReconciler().reconcile(input, now)
  const linked = scene.claims.filter(c => c.cardId === fixtureId(1) && c.verification === 'confirmed')
  expect(linked).toHaveLength(2)
  expect(linked.every(c => c.sources.length === 1 && c.sources[0] === 'notion.First Mate tasks')).toBe(true)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: { items: [], sources: [] } } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  await page.goto(base)
  const card = page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)
  await expect(page.locator('.ov-group').filter({ has: card }).locator('.ov-line.ov-linked')).toHaveCount(2)
  await expect(card).not.toContainText('First Mate tasks')
  await inspectEntity(page, card)
  await expect(page.getByLabel('Inspector', { exact: true })).toContainText('Connections & history')
  await page.getByText('Evidence & diagnostics', { exact: true }).click()
  await expect(page.getByLabel('Inspector', { exact: true })).toContainText('notion.First Mate tasks')
  await screenshot(page, 'notion-owned-confirmed-links-fixture')
})

test('Ultra Compact density, canonical fan-out, keyboard, geometry and reload persistence', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1200 })
  const now = Date.now(), scene = fixtureScene({ now })
  const first = scene.claims.find(c => c.cardId === fixtureId(1))!
  scene.claims.push({ ...first, id: 'ui-second-direct-task', cardId: fixtureId(6) })
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.goto(base)
  await clickAdvanced(page, 'Ultra Compact')
  const workerId = scene.executions.find(w => w.identity.task_id === 'linked-worker')!.id
  const worker = page.locator('.ov-execution').filter({ hasText: 'linked worker' })
  const helper = page.locator('.ov-execution').filter({ hasText: 'helper worker' })
  const task = page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)
  const second = page.locator(`.ov-card[data-entity-id="${fixtureId(6)}"]`)
  await expect(worker).toHaveAttribute('aria-expanded', 'false')
  expect((await worker.boundingBox())!.height).toBe(29)
  const heights = await page.locator('.ov-outer>.ov-group-head,.ov-inner .ov-group-head').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))
  expect(heights).toContain(25); expect(heights).toContain(21)
  await worker.focus(); await worker.press('Enter')
  await expect(worker).toBeFocused()
  await expect(task).toHaveAttribute('aria-expanded', 'true')
  await expect(second).toHaveAttribute('aria-expanded', 'true')
  await expect(helper).toHaveAttribute('aria-expanded', 'false')
  await worker.press('Space')
  await expect(task).toHaveAttribute('aria-expanded', 'false')
  await selectAdvanced(page, 'Outer grouping', 'machine')
  await selectAdvanced(page, 'Inner grouping', 'none')
  await expect(task).toHaveCount(1)
  await task.click()
  await expect(worker).toHaveAttribute('aria-expanded', 'true')
  await expect(helper).toHaveAttribute('aria-expanded', 'true')
  await expect(second).toHaveAttribute('aria-expanded', 'false')
  const anchors = async () => page.evaluate(({ workerId, taskId }) => {
    const path = Array.from(document.querySelectorAll<SVGPathElement>('.ov-compact-connections path')).find(el => el.dataset.workerId === workerId && el.dataset.cardId === taskId)!
    const worker = Array.from(document.querySelectorAll<HTMLElement>('.ov-execution')).find(el => el.dataset.entityId === workerId)!.getBoundingClientRect()
    const task = document.querySelector<HTMLElement>(`.ov-card[data-entity-id="${taskId}"]`)!.getBoundingClientRect()
    const canvas = document.querySelector('.ov-canvas')!.getBoundingClientRect()
    const start = path.getPointAtLength(0), end = path.getPointAtLength(path.getTotalLength())
    return Math.max(Math.abs(start.x - (worker.right - canvas.left)), Math.abs(start.y - (worker.top + worker.height / 2 - canvas.top)), Math.abs(end.x - (task.left - canvas.left)), Math.abs(end.y - (task.top + task.height / 2 - canvas.top)))
  }, { workerId, taskId: fixtureId(1) })
  await expect.poll(anchors).toBeLessThan(1)
  await clickAdvanced(page, 'Reverse sort direction')
  await expect.poll(anchors).toBeLessThan(1)
  await page.setViewportSize({ width: 700, height: 900 })
  await page.locator('.ov-workspace').evaluate(el => { el.scrollTop = 80; el.scrollLeft = 100 })
  await expect.poll(anchors).toBeLessThan(1)
  const positions = await page.evaluate(() => ({ worker: document.querySelector('.ov-execution')!.getBoundingClientRect().left, task: document.querySelector('.ov-card')!.getBoundingClientRect().left, doc: document.documentElement.scrollWidth, viewport: innerWidth }))
  expect(positions.worker).toBeLessThan(positions.task)
  expect(positions.doc).toBe(positions.viewport)
  await page.reload()
  await expect(page.locator('.ov')).toHaveAttribute('data-density', 'compact')
  await clickAdvanced(page, 'Detailed')
  await page.reload()
  await expect(page.locator('.ov')).toHaveAttribute('data-density', 'detailed')
})

for (const viewport of [{ width: 1920, height: 1200 }, { width: 1366, height: 900 }, { width: 700, height: 900 }, { width: 390, height: 844 }]) test(`single-row toolbar presets, status fan-out and persistence at ${viewport.width}px`, async ({ page }) => {
  await page.setViewportSize(viewport)
  const now = Date.now(), scene = fixtureScene({ now })
  const first = scene.claims.find(c => c.cardId === fixtureId(1))!
  scene.claims.push({ ...first, id: 'toolbar-fanout', cardId: fixtureId(6) }, { ...first, id: 'repeated-evidence' })
  const { fixtureQueue } = await import('../test-fixtures/reconciliation/scenes')
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: fixtureQueue(now) } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  await page.goto(base)
  const toolbar = page.getByRole('toolbar', { name: 'Arrange work' })
  await expect(toolbar).toBeVisible()
  expect((await toolbar.boundingBox())!.height).toBe(48)
  expect((await page.locator('.ov-headings').boundingBox())!.y).toBe((await toolbar.boundingBox())!.y + 48)
  await expect(page.locator('.ov-top,.ov-intro')).toHaveCount(0)
  await expect(page.getByLabel('Outer grouping')).toHaveCount(0)
  const cardIds = () => page.locator('.ov-card').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-entity-id')).sort())
  const counts = async (cards: number, workers: number) => {
    await expect(page.locator('.ov-card')).toHaveCount(cards)
    await expect(page.locator('.ov-execution')).toHaveCount(workers)
    await expect(page.locator('.ov-headings')).toContainText(`WORKERS · ${workers}`)
    await expect(page.locator('.ov-headings')).toContainText(`NOTION TASKS · ${cards}`)
  }
  await counts(5, 5)
  for (const [label, outer, inner] of [['By Machine', 'machine', 'initiative'], ['By Manager', 'manager', 'initiative'], ['By Initiative', 'initiative', 'manager']]) {
    await page.getByRole('button', { name: label!, exact: true }).click()
    await expect(page.locator('.ov')).toHaveAttribute('data-outer', outer!)
    await expect(page.locator('.ov')).toHaveAttribute('data-inner', inner!)
    await expect(page.locator('.ov')).toHaveAttribute('data-order', 'operational')
  }
  const slice = (name: string) => page.getByRole('button', { name, exact: true })
  await clickStatusSlice(page, 'Cards: Waiting For, 1')
  await counts(1, 1)
  await (await tabToStatusSlice(page, 'Cards: Waiting For, 1')).press('Space')
  await counts(5, 5)
  await slice('Cards: Waiting For, 1').press('Enter')
  await counts(1, 1)
  expect(await cardIds()).toEqual([fixtureId(4)])
  await expect(page.getByRole('button', { name: 'Workers statuses: 1 visible, 1 eligible' })).toBeVisible()
  await clickStatusSlice(page, 'Cards: In Progress, 4')
  await counts(5, 3) // OR in the card donut; independent workers disappear.
  await clickStatusSlice(page, 'Workers: Running, 2')
  await counts(2, 2)
  await (await tabToStatusSlice(page, 'Workers: Running, 2')).press('Space')
  await counts(5, 3)
  await slice('Workers: Running, 2').press('Enter')
  await counts(2, 2) // AND across donuts; a canonical task is counted once.
  expect(await cardIds()).toEqual([fixtureId(1), fixtureId(6)])
  await expect(page.locator('.ov-workspace')).not.toContainText('No linked worker')
  await page.getByRole('button', { name: 'By Machine', exact: true }).click()
  await counts(2, 2)
  await expect(page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"] .ov-reference`)).toHaveCount(1)
  await page.reload()
  await counts(2, 2)
  await expect(page.getByRole('button', { name: 'By Machine', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(slice('Cards: In Progress, 2')).toHaveAttribute('aria-pressed', 'true')
  const clear = page.getByRole('button', { name: 'Clear all status selections' })
  await clear.scrollIntoViewIfNeeded()
  const clearBox = (await clear.boundingBox())!
  expect(clearBox.x).toBeGreaterThanOrEqual(0)
  expect(clearBox.x + clearBox.width).toBeLessThanOrEqual(viewport.width)
  await clear.click()
  await counts(5, 5)
  await expect(page.getByRole('button', { name: 'By Machine', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await openCustomize(page)
  await page.getByLabel('Order by', { exact: true }).selectOption('due')
  await page.getByLabel('Order by', { exact: true }).press('Escape')
  await expect(page.getByRole('button', { name: 'Customize', exact: true })).toBeFocused()
  await page.reload()
  await expect(page.locator('.ov')).toHaveAttribute('data-order', 'due')
  expect((await toolbar.boundingBox())!.height).toBe(48)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

test('single-row toolbar Smart Search ranks, filters one-hop clusters and restores scroll and filters', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const proofNow = Date.parse('2026-11-06T00:00:00Z')
  await page.clock.install({ time: proofNow })
  const scene = fixtureScene({ now: proofNow, size: 143 })
  scene.cards.find(card => card.id === fixtureId(1))!.source.properties.Name!.value = 'Release Coordinator'
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  await page.addInitScript(() => localStorage.setItem('tinstar.floor.preferences', JSON.stringify({ organizer: { outer: 'machine', inner: 'none', order: 'operational', direction: 'asc' } })))
  await page.goto(base)
  await expect(page.locator('.ov')).toHaveAttribute('data-density', 'compact')
  const beforeCards = await page.locator('.ov-card').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-entity-id')))
  await expect(page.locator('.ov-toolbar')).toHaveJSProperty('offsetHeight', 48)
  await expect(page.locator('.ov-donut')).toHaveCount(2)
  await page.locator('.ov-workspace').evaluate(node => { node.scrollTop = 420 })
  const previousScroll = await page.locator('.ov-workspace').evaluate(node => node.scrollTop)
  await page.keyboard.press('Control+k')
  const input = page.getByRole('combobox', { name: 'Find names, IDs and text', exact: true })
  const results = page.getByRole('listbox', { name: 'Search results' })
  await expect(input).toBeFocused()
  await expect(results.getByRole('option')).toHaveCount(0)
  await input.fill('releese coordnator')
  await expect(results.getByRole('option')).toHaveCount(1)
  await expect(results).toContainText('Release Coordinator')
  await expect(page.locator('.ov-card')).toHaveCount(beforeCards.length)
  const palette = await page.getByRole('dialog', { name: 'Smart Search' }).boundingBox()
  expect(palette!.width).toBeLessThanOrEqual(480)
  expect(palette!.height).toBeLessThan(200)
  await screenshot(page, 'smart-search-desktop-fuzzy')
  await input.press('ArrowDown'); await input.press('Enter')
  const card = page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)
  await expect(card).toBeFocused()
  await expect(card).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.ov-execution')).toHaveCount(2)
  await expect(page.locator('.ov-card')).toHaveCount(1)
  await expect(page.locator('.ov-execution.ov-search-context')).toHaveCount(2)
  await expect(page.locator('.ov-search-context').first()).toHaveCSS('opacity', '0.65')
  const paths = page.locator('.ov-compact-connections path')
  expect(await paths.count()).toBeGreaterThan(1)
  await screenshot(page, 'smart-search-desktop-focus')
  // Opening search over focus creates two reversible dismissal levels.
  await page.keyboard.press('Control+k'); await input.press('Escape')
  await expect(page.locator('.ov-card.ov-search-match')).toHaveCount(1)
  await page.keyboard.press('Escape')
  expect(await page.locator('.ov-card').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-entity-id')))).toEqual(beforeCards)
  expect(await page.locator('.ov-workspace').evaluate(node => node.scrollTop)).toBeCloseTo(previousScroll, 0)
  await expect(page.locator('.ov')).toHaveAttribute('data-outer', 'machine')
  await screenshot(page, 'smart-search-desktop-restored')
  await page.keyboard.press('Control+k'); await input.fill('Roadmap: planned integration')
  const outside = results.getByRole('option').filter({ hasText: 'Roadmap: planned integration' })
  await expect(outside).toContainText('Outside current view'); await outside.click()
  await expect(page.locator(`.ov-card[data-entity-id="${fixtureId(5)}"]`)).toHaveCount(1)
  await expect(page.locator('.ov-card')).toHaveCount(1)
  await expect(page.locator('.ov')).toHaveAttribute('data-preset', 'operational')
  await page.getByRole('button', { name: 'Clear search focus', exact: true }).click()
  await expect(page.locator(`.ov-card[data-entity-id="${fixtureId(5)}"]`)).toHaveCount(0)
})

test('single-row toolbar Smart Search exact identifiers, named entities and explicit decision dial', async ({ page }) => {
  const proofNow = Date.parse('2026-11-06T00:00:00Z')
  await page.clock.install({ time: proofNow })
  const scene: FloorScene = fixtureScene({ now: proofNow })
  for (const card of scene.cards) { delete card.source.properties.Initiative; card.ancestry = ['parent-only'] }
  const card = scene.cards.find(card => card.id === fixtureId(2))!
  card.source.properties.Initiative = { id: 'initiative', type: 'relation', value: ['explicit'], hasMore: false }
  card.source.properties['Will action'] = { id: 'will', type: 'multi_select', value: ['Decision', 'Merge'], hasMore: false }
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  await page.goto(base)
  await expect(page.getByRole('button', { name: 'Smart Search (Ctrl or Command K)', exact: true })).toBeVisible()
  await page.keyboard.press('Control+k')
  const input = page.getByRole('combobox', { name: 'Find names, IDs and text', exact: true }), results = page.getByRole('listbox', { name: 'Search results' })
  await input.fill('explicit')
  await expect(results.getByRole('option', { name: /^explicit.*Initiative/ })).toHaveCount(1)
  await input.fill('parent-only'); await expect(results.getByRole('option')).toHaveCount(0)
  await input.fill('Hulk'); await results.getByRole('option', { name: /^Hulk.*Machine/ }).click()
  await expect(page.locator('.ov-execution.ov-search-match')).toHaveCount(4)
  await page.keyboard.press('Escape')
  const center = page.locator('.ov-pattern-selected')
  await center.focus(); await center.press('ArrowRight'); await center.press('ArrowRight'); await center.press('ArrowRight')
  await expect(center).toContainText('Needs me')
  await expect(page.locator('.ov-card')).toHaveCount(2)
  await expect(page.locator('.ov-pattern-summary')).toHaveCount(0)
  await expect(page.locator('.ov-card')).not.toContainText(["Can't tell", "Can't tell"])
  await screenshot(page, 'smart-search-explicit-decision')
  // Deliver disposable source snapshots through the running browser's normal refresh.
  const text = '  PR #29201; PR #2920 then oﬃce release'
  for (const field of ['identifier', 'name', 'body']) {
    scene.searchIndex = { notes: ['Disposable authorized source snapshot'], documents: [{ key: `card:${card.id}`, target: { kind: 'card', id: card.id }, title: field === 'name' ? text : 'NEM3', identifiers: field === 'identifier' ? [text, '0143'] : ['0143'], fields: [{ name: field === 'name' ? 'Name' : 'Description', source: 'Notion blocks', text: field === 'identifier' ? 'Known PR' : text }], observedAt: new Date(proofNow).toISOString(), expiresAt: new Date(proofNow + 60_000).toISOString(), coverage: 'fresh/complete' }] }
    await page.reload()
    await expect(page.getByRole('button', { name: 'Smart Search (Ctrl or Command K)', exact: true })).toBeVisible()
    await page.keyboard.press('Control+k'); await input.fill('"PR #2920"')
    await expect(results.getByRole('option')).toHaveCount(1)
    await input.fill('29201x'); await expect(results.getByRole('option')).toHaveCount(0)
    await input.fill('0142'); await expect(results.getByRole('option')).toHaveCount(0)
    await input.fill('0143'); await expect(results.getByRole('option')).toHaveCount(1)
    if (field !== 'identifier') { await input.fill('office'); await expect(results.getByRole('option')).toHaveCount(1) }
  }
})

for (const width of [1440, 390]) test(`single-row toolbar Pattern Dial readiness counts and stale home explanations at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const proofNow = Date.parse('2026-11-09T16:00:00Z')
  await page.clock.install({ time: proofNow })
  let scene = fixtureReadinessScene({ now: proofNow })
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  await page.goto(base)
  const center = page.locator('.ov-pattern-selected')
  await expect(center).toHaveAccessibleName(/All, 2 matching tasks\.\s+Show explanation/)
  await center.press('ArrowLeft')
  await expect(center).toHaveAccessibleName(/Active, 1 matching tasks\.\s+Show explanation/)
  await screenshot(page, `readiness-active-${width}`)
  await center.press('ArrowRight'); await center.press('ArrowRight')
  await expect(center).toHaveAccessibleName(/Stalled, 1 matching tasks\.\s+Show explanation/)
  await center.click()
  await expect(page.getByRole('tooltip')).toContainText('Stalled · 1 matching tasks')
  await screenshot(page, `readiness-stalled-${width}`)
  scene = fixtureReadinessScene({ now: proofNow, stale: true })
  await page.reload()
  await expect(center).toHaveAccessibleName(/Stalled, \? matching tasks, incomplete evidence\. Selected pattern could not evaluate/)
  await center.click()
  const tooltip = page.getByRole('dialog', { name: 'Stalled pattern coverage' })
  await expect(tooltip).toContainText('worker snapshots unavailable or stale')
  await expect(tooltip).toContainText('runnable work unknown')
  const bounds = await tooltip.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width)
  await screenshot(page, `readiness-unknown-${width}`)
  await center.press('Escape'); await center.press('ArrowLeft'); await center.press('ArrowLeft')
  await expect(center).toHaveAccessibleName(/Active, 1\+ matching tasks, incomplete evidence\. Selected pattern could not evaluate/)
  await expect(page.locator('.ov-toolbar')).toHaveJSProperty('offsetHeight', 48)
  await expect(page.locator('.ov-donut')).toHaveCount(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
})

test('single-row toolbar Pattern Dial and compact palette support touch, keyboard, tooltip and narrow widths', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const proofNow = Date.parse('2026-11-06T00:00:00Z')
  await page.clock.install({ time: proofNow })
  const scene = fixtureScene({ now: proofNow })
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  await page.goto(base)
  await page.getByRole('button', { name: 'Smart Search (Ctrl or Command K)', exact: true }).click()
  const panel = page.getByRole('dialog', { name: 'Smart Search', exact: true }), input = panel.getByRole('combobox')
  expect(await input.evaluate(element => { const rect = element.getBoundingClientRect(); return document.elementFromPoint(rect.left + 4, rect.top + rect.height / 2) === element })).toBe(true)
  await expect(panel.getByRole('option')).toHaveCount(0)
  await expect(panel.getByRole('combobox')).toHaveCount(1)
  await input.fill('Waiting for input'); await input.press('Enter')
  await expect(panel).toHaveCount(0)
  await expect(page.locator('.ov-card.ov-search-match')).toHaveCount(1)
  await screenshot(page, 'smart-search-phone-focus')
  await page.keyboard.press('Control+k')
  await page.goBack()
  await expect(panel).toHaveCount(0)
  await expect(page.locator('.ov-card.ov-search-match')).toHaveCount(1)
  await page.goBack()
  await expect(page.locator('.ov-card.ov-search-match')).toHaveCount(0)
  const center = page.locator('.ov-pattern-selected'), dial = page.getByRole('group', { name: 'Operational pattern dial', exact: true })
  await center.focus(); await center.press('ArrowRight')
  await expect(center).toContainText('Stalled')
  await page.getByRole('button', { name: /^Select Blocked,/ }).click()
  await expect(center).toContainText('Blocked'); await expect(page.locator('.ov-card')).toHaveCount(1)
  await center.hover(); await page.clock.runFor(450)
  await expect(page.getByRole('tooltip')).toContainText('blocked can be healthy')
  const bounds = await page.getByRole('tooltip').boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await screenshot(page, 'smart-search-phone-pattern-tooltip')
  await center.click(); await page.mouse.move(1, 1)
  await expect(page.getByRole('tooltip')).toBeVisible()
  await center.press('Escape')
  await expect(page.getByRole('tooltip')).toHaveCount(0); await expect(center).toContainText('Blocked')
  await dial.dispatchEvent('wheel', { deltaX: 40, deltaY: 0 })
  await dial.dispatchEvent('wheel', { deltaX: 40, deltaY: 0 })
  await expect(center).toContainText('Needs me')
  const box = (await center.boundingBox())!, client = await page.context().newCDPSession(page)
  const touch = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touch] })
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touch, x: touch.x + 55 }] })
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await client.detach()
  await expect(center).toContainText('Blocked')
  await dial.dispatchEvent('wheel', { deltaX: 0, deltaY: 100 })
  await expect(center).toContainText('Blocked')
  await expect(page.locator('.ov-toolbar')).toHaveJSProperty('offsetHeight', 48)
  await expect(page.locator('.ov-donut')).toHaveCount(2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})

for (const width of [1440, 390]) {
  test(`compact Ask semantics and inbox at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    const scene = fixtureScene(), source = scene.cards.find(card => card.id === fixtureId(1))!
    source.source.properties.Priority = { id: 'priority', type: 'select', value: 'Medium', hasMore: false }
    source.source.properties['Next check-in'] = { id: 'check', type: 'date', value: { start: '2026-11-01T12:00:00Z' }, hasMore: false }
    source.source.properties['Waiting For'] = { id: 'wait', type: 'rich_text', value: 'Reviewer capacity', hasMore: false }
    await page.addInitScript(() => localStorage.setItem('tinstar.overview.density', 'compact'))
    await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
    await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: { items: [], generatedAt: scene.generatedAt } } }))
    await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: fixtureViewerWorkers(), attention: [], errors: [] } } }))
    const submitted: Array<Record<string, unknown>> = []
    const records: Array<Record<string, unknown>> = []
    await page.route('**/api/ask/**', async route => {
      const req = route.request(), body = req.method() === 'POST' ? req.postDataJSON() : null
      if (req.url().endsWith('/requests') && body) {
        submitted.push(body)
        const id = crypto.randomUUID()
        records.push({ request_id: id, conversation_id: id, question: body.question, input_mode: 'text', context: { anchor: { kind: 'work', page_id: body.card_id, label: 'Build live reconciliation', url: `https://www.notion.so/${body.card_id}`, observed_at: scene.generatedAt }, view: { scene: 'overview' }, field_key: body.field_key, field_value: body.field_value }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'answered', reply: { summary: 'The reviewer is preparing the next pass.', detail: 'Checked current source evidence.', references: [], suggested_actions: [] }, error: null, read_at: null, dismissed_at: null })
        return route.fulfill({ json: { ok: true, data: records.at(-1) } })
      }
      return route.fulfill({ json: { ok: true, data: records } })
    })
    await page.goto(base)
    const card = page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`).first()
    const frame = page.locator('.ov-item-frame').filter({ has: card }).first()
    await expect(card).toHaveAttribute('aria-expanded', 'false')
    expect((await card.boundingBox())!.height).toBe(29)
    await expect(frame.getByRole('button', { name: 'Ask about this item', exact: true })).toBeVisible()
    await expect(frame.getByRole('button', { name: 'Open in Inspector', exact: true })).toBeVisible()
    await card.scrollIntoViewIfNeeded()
    const before = await card.boundingBox()
    const pathsBefore = await page.locator('.ov-connections .ov-line').evaluateAll(paths => paths.map(path => path.getAttribute('d')))
    await frame.getByRole('button', { name: 'Ask about this item', exact: true }).click()
    const question = page.getByRole('textbox', { name: 'Question', exact: true })
    await expect(question).toBeFocused()
    await expect(question).toHaveValue('')
    expect(await card.boundingBox()).toEqual(before)
    expect(await page.locator('.ov-connections .ov-line').evaluateAll(paths => paths.map(path => path.getAttribute('d')))).toEqual(pathsBefore)
    const dialogBox = (await page.getByRole('dialog').boundingBox())!
    expect(dialogBox.x).toBeGreaterThanOrEqual(0)
    expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(width)
    expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(900)
    await question.fill('Line one')
    await question.press('Shift+Enter')
    await question.press('a')
    await expect(question).toHaveValue('Line one\na')
    expect(submitted).toHaveLength(0)
    await question.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await card.click()
    const fields = [
      ['.ov-check', 'Why is this overdue?'],
      ['.ov-task-status', 'Why is this task in this status? What is happening now?'],
      ['.ov-context-field[title^="Waiting For:"]', "What's preventing this from moving forward?"],
      ['.ov-owner', 'What is this owner doing on the task?'],
      ['.ov-priority', 'Why does this task have this priority?'],
      ['.ov-age', 'What changed in the last edit?'],
      ['strong', "What's the current situation with this task?"],
    ]
    for (const [selector, draft] of fields) {
      await card.locator(selector!).click({ button: 'right' })
      await expect(question).toHaveValue(draft!)
      expect(submitted).toHaveLength(0)
      await question.press('Escape')
    }
    const line = page.locator('.ov-relationship-hit').first()
    await line.focus()
    await line.press('Enter')
    await expect(question).toHaveValue('How are these two items related?')
    await question.press('Escape')
    const native = await page.getByRole('button', { name: 'By Initiative', exact: true }).evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
    expect(native).toBe(true)
    await frame.getByRole('button', { name: 'Ask about this item', exact: true }).click()
    await question.fill('Why is this waiting?')
    await question.press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(submitted).toMatchObject([{ card_id: fixtureId(1), question: 'Why is this waiting?' }])
    await page.reload()
    if (width === 390) await page.getByRole('button', { name: 'Your desk', exact: true }).click()
    const desk = page.getByLabel('Your desk', { exact: true })
    await expect(desk.getByRole('button', { name: /New answer.*Why is this waiting/ })).toBeVisible()
    await expect(desk.getByText('The reviewer is preparing the next pass.')).toBeVisible()
    for (const text of ['No verified Notion card ready.', 'First Mate requests', 'Questions', 'Ask about a task']) await expect(desk.getByText(text, { exact: true })).toHaveCount(0)
    await expect(desk.getByRole('button', { name: 'Dismiss to history' })).toBeHidden()
    await desk.getByRole('button', { name: /New answer.*Why is this waiting/ }).click()
    await expect(card).toHaveClass(/flashed/)
    await expect(page.getByRole('dialog')).toContainText('The reviewer is preparing the next pass.')
  })
}

test('mobile successive search results release history ownership without leaving Overview', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const scene = fixtureScene({ now: Date.now() })
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  await page.goto(base)
  await expect(page.locator('.ov')).toBeVisible()
  const originalUrl = page.url()
  await page.evaluate(() => history.replaceState({ sentinel: 'overview-baseline' }, '', location.href))
  const beforeCards = await page.locator('.ov-card').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-entity-id')))
  const choose = async (query: string) => {
    await page.getByRole('button', { name: 'Smart Search (Ctrl or Command K)', exact: true }).click()
    const input = page.getByRole('combobox', { name: 'Find names, IDs and text', exact: true })
    await input.fill(query)
    await input.press('Enter')
    await expect(page.getByRole('dialog', { name: 'Smart Search', exact: true })).toHaveCount(0)
    await expect(page.locator('.ov-card.ov-search-match')).toHaveCount(1)
  }
  await choose('Waiting for input')
  await choose('Roadmap: planned integration')
  await page.goBack()
  await expect(page.locator('.ov-card.ov-search-match')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => history.state)).toEqual({ sentinel: 'overview-baseline' })
  await choose('Waiting for input')
  const clear = page.getByRole('button', { name: 'Clear search focus', exact: true })
  await clear.scrollIntoViewIfNeeded()
  await clear.click()
  await expect(page.locator('.ov-card.ov-search-match')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => history.state)).toEqual({ sentinel: 'overview-baseline' })
  await expect(page.locator('.ov')).toBeVisible()
  expect(page.url()).toBe(originalUrl)
  expect(await page.locator('.ov-card').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-entity-id')))).toEqual(beforeCards)
  await screenshot(page, 'smart-search-mobile-history-restored')
})


for (const density of ['compact', 'detailed']) test(`card worker facts and one unchecked summary preserve unknown accountability in ${density}`, async ({ page }) => {
  await page.addInitScript(density => localStorage.setItem('tinstar.overview.density', density), density)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const now = Date.parse('2026-11-09T21:00:00Z')
  await page.clock.install({ time: now })
  const sources = fixtureSources({ now })
  let scene = new SceneReconciler().reconcile(sources, now)
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  await page.goto(base)
  const card = (n: number) => page.locator(`.ov-card[data-entity-id="${fixtureId(n)}"]`)
  await expect(card(1)).toContainText('2 workers running')
  await expect(card(2)).toContainText('No worker')
  const center = page.locator('.ov-pattern-selected')
  await center.press('ArrowRight')
  await expect(page.locator('.ov-pattern-summary')).toHaveCount(0)
  await expect(page.locator('.ov')).not.toContainText("Can't tell")
  await expect(card(2)).toBeVisible()
  await screenshot(page, `in-progress-after-${density}`)
  await center.press('ArrowLeft')
  for (const home of sources.fleet) home.observation.data!.backlog = []
  scene = new SceneReconciler().reconcile(sources, now)
  await page.reload()
  await expect(card(2)).toBeVisible()
  await expect(card(2)).not.toContainText('No worker')
  await expect(card(1)).toContainText('2 workers running')
  const helper = sources.fleet.flatMap(home => home.observation.data!.tasks).find(task => task.id === 'helper-worker')!
  helper.current_state.state = 'unknown'
  scene = new SceneReconciler().reconcile(sources, now)
  await page.reload()
  await expect(card(1)).toContainText('1 worker running · 1 worker, no update since 2026-11-09 20:59 UTC')
  await screenshot(page, `unknown-accountability-after-${density}`)
  helper.current_state.state = 'paused'; helper.last_event.state = 'paused'; helper.last_event.age_seconds = 10800
  scene = new SceneReconciler().reconcile(sources, now)
  await page.reload()
  await expect(card(1)).toContainText('1 worker waiting · reported 3h ago')
  await card(1).click()
  await expect(card(1)).toContainText('1 worker waiting · reported 3h ago')
  await screenshot(page, `worker-facts-expanded-after-${density}`)
})

for (const width of [1440, 390]) test(`single-row toolbar scoped pattern coverage and exact drilldown at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 })
  const now = Date.parse('2026-11-10T12:00:00Z')
  await page.clock.install({ time: now })
  const sources = fixtureSources({ now })
  const template = sources.intentions.data!.cards.find(card => card.id === fixtureId(2))!
  sources.intentions.data!.cards = Array.from({ length: 127 }, (_, i) => ({ ...structuredClone(template), id: fixtureId(100 + i) }))
  sources.fleet = []
  const scene = new SceneReconciler().reconcile(sources, now)
  const writes: string[] = []
  page.on('request', req => { if (req.method() !== 'GET' && !req.url().includes('/api/reconciliation/ui')) writes.push(req.url()) })
  await page.route('**/api/reconciliation/scene*', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  await page.goto(base)
  const center = page.locator('.ov-pattern-selected')
  await expect(page.locator('.ov-card')).toHaveCount(127)
  await expect(page.locator('.ov-pattern-coverage')).toHaveCount(0)
  await screenshot(page, `pattern-all-${width}`)
  await center.press('ArrowRight')
  await expect(center).toContainText('Pattern unknown: 127')
  await expect(page.locator('.ov-pattern-summary')).toHaveCount(0)
  await expect(page.locator('.ov-toolbar')).toHaveJSProperty('offsetHeight', 48)
  await center.click()
  const detail = page.getByRole('dialog', { name: 'Stalled pattern coverage' })
  await expect(detail).toContainText('127 of 127 visible cards; 0 evaluated')
  await expect(detail).toContainText('not a confirmed problem or request for you')
  await screenshot(page, `pattern-unknown-${width}`)
  await detail.getByRole('button', { name: 'Inspect 127 cards with unknown pattern' }).click()
  await expect(page.locator('.ov-card.ov-search-match')).toHaveCount(127)
  expect(new Set(await page.locator('.ov-card').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-entity-id'))))).toEqual(new Set(scene.cards.map(card => card.id)))
  await screenshot(page, `pattern-drilldown-${width}`)
  await page.getByRole('button', { name: 'Clear search focus', exact: true }).click()
  await center.press('ArrowRight')
  await expect(page.locator('.ov-pattern-coverage')).toHaveCount(0)
  await center.press('ArrowLeft'); await center.press('ArrowLeft')
  await expect(page.locator('.ov-pattern-coverage')).toHaveCount(0)
  expect(writes).toEqual([])
})

test('single-row toolbar external reports and status boundaries preserve truthful worker facts', async ({ page }) => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  await page.clock.install({ time: now })
  let scene = fixtureScene({ now })
  await page.route('**/api/reconciliation/scene*', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  for (const condition of ['current', 'stale', 'different-card', 'Queued', 'Waiting For', 'Waiting for Prod Release', 'Done', 'Archived']) {
    const sources = fixtureSources({ now })
    const card = sources.intentions.data!.cards.find(card => card.id === fixtureId(2))!
    if (['current', 'stale', 'different-card'].includes(condition)) card.properties['Delegated To'] = { id: 'external', type: 'rich_text', hasMore: false, value: JSON.stringify({ schema: 'tinstar.external-worker.v1', kind: 'external', system: 'Build runner', run_id: 'one', reference: 'https://runner.example/one', card_id: condition === 'different-card' ? fixtureId(1) : card.id, observed_at: new Date(now - (condition === 'stale' ? 600000 : 0)).toISOString(), state: 'running', evidence: 'Actively compiling assigned work', reported_by: 'Clawson' }) }
    else card.properties.Status!.value = condition
    scene = new SceneReconciler().reconcile(sources, now)
    await page.goto(base)
    const customize = page.getByRole('button', { name: 'Customize', exact: true })
    await customize.click(); await page.getByLabel('Status preset', { exact: true }).selectOption('all'); await customize.click()
    const rendered = page.locator(`.ov-card[data-entity-id="${card.id}"]`).first()
    await expect(rendered).toBeVisible()
    if (condition === 'different-card') await expect(rendered).toContainText('No worker')
    else { await expect(rendered).not.toContainText('No worker'); await expect(rendered).not.toHaveAttribute('data-tone', 'gap') }
    await screenshot(page, `worker-boundary-${condition.replaceAll(' ', '-')}`)
  }
})

test('single-row toolbar link evidence boundaries keep pattern unknown separate from conflicts', async ({ page }) => {
  const { readWorkerLinks } = await import('../src/server/reconciliation/workerLinks')
  const now = Date.parse('2026-11-10T12:00:00Z')
  await page.clock.install({ time: now })
  let scene = fixtureScene({ now })
  await page.route('**/api/reconciliation/scene*', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  for (const condition of ['blank', 'empty', 'verified', 'conflict', 'missing-home', 'stale-home', 'partial-home']) {
    const sources = fixtureSources({ now })
    const card = sources.intentions.data!.cards.find(card => card.id === fixtureId(1))!
    if (condition === 'blank') { card.properties['First Mate tasks']!.value = ''; card.properties['First Mate tasks']!.workerLinks = readWorkerLinks({ type: 'rich_text', rich_text: [] }) }
    if (condition === 'empty') card.properties['First Mate tasks']!.value = JSON.stringify({ schema: 'tinstar.fm-links.v1', tasks: [] })
    if (condition === 'conflict') card.properties['First Mate tasks']!.value = '{'
    if (condition === 'missing-home') sources.fleet = []
    if (condition === 'stale-home') sources.fleet[1]!.observation.status = 'stale'
    if (condition === 'partial-home') sources.fleet[0]!.observation.coverage = 'partial'
    scene = new SceneReconciler().reconcile(sources, now)
    await page.goto(base)
    const center = page.locator('.ov-pattern-selected')
    await center.focus(); await center.press('Enter')
    await page.getByRole('option', { name: /^Stale,/ }).click()
    await expect(center).toContainText('Pattern unknown:')
    await expect(page.locator(`.ov-card[data-entity-id="${card.id}"]`).first()).not.toContainText('No worker')
    await center.click()
    await expect(page.getByRole('dialog', { name: 'Stale pattern coverage' })).toContainText('progress time unknown')
    await screenshot(page, `link-evidence-${condition}`)
    if (condition === 'conflict') {
      await page.keyboard.press('Escape')
      await page.getByRole('button', { name: /· Details$/ }).click()
      await expect(page.getByRole('region', { name: 'Source health' })).toContainText('1 card has conflicting worker evidence')
      await screenshot(page, 'link-evidence-conflict-details')
    }
  }
})

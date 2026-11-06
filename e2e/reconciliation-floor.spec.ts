import { expect, test, type Page, type Locator } from '@playwright/test'
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

test('single-row toolbar Smart Search ranks, reveals one-hop clusters and restores scroll and filters', async ({ page }) => {
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
  const toolbarHeight = await page.locator('.ov-toolbar').evaluate(node => node.getBoundingClientRect().height)
  await page.locator('.ov-workspace').evaluate(node => { node.scrollTop = 420 })
  const previousScroll = await page.locator('.ov-workspace').evaluate(node => node.scrollTop)
  await page.keyboard.press('Control+k')
  const input = page.getByRole('combobox', { name: 'Find names, IDs and text', exact: true })
  await expect(input).toBeFocused()
  await input.fill('releese coordnator')
  const results = page.getByRole('listbox', { name: 'Search results' })
  await expect(results.getByRole('option')).toHaveCount(1)
  await expect(results).toContainText('Release Coordinator')
  await expect(results.locator('mark')).not.toHaveCount(0)
  await screenshot(page, 'smart-search-desktop-fuzzy')
  await input.press('ArrowDown')
  await input.press('Enter')
  const card = page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)
  await expect(card).toHaveCount(1)
  await expect(card).toBeFocused()
  await expect(card).toHaveAttribute('aria-expanded', 'true')
  await expect(page.locator('.ov-execution')).toHaveCount(2)
  await expect(page.locator('.ov-toolbar')).toHaveJSProperty('offsetHeight', toolbarHeight)
  await page.keyboard.press('Escape')
  await expect(page.locator('.ov-card')).toHaveCount(beforeCards.length)
  expect(await page.locator('.ov-card').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-entity-id')))).toEqual(beforeCards)
  expect(await page.locator('.ov-workspace').evaluate(node => node.scrollTop)).toBeCloseTo(previousScroll, 0)
  await expect(page.locator('.ov')).toHaveAttribute('data-outer', 'machine')
  await screenshot(page, 'smart-search-desktop-restored')
  for (const label of ['Smart Search (Ctrl or Command K)', 'Remove search text']) {
    await page.keyboard.press('Control+k')
    await input.fill('Release')
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click()
    await page.getByRole('button', { name: label, exact: true }).press('Escape')
    expect(await page.locator('.ov-card').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-entity-id')))).toEqual(beforeCards)
    expect(await page.locator('.ov-workspace').evaluate(node => node.scrollTop)).toBeCloseTo(previousScroll, 0)
  }
  await page.keyboard.press('Control+k')
  await input.fill('Roadmap: planned integration')
  const outside = results.getByRole('option').filter({ hasText: 'Roadmap: planned integration' })
  await expect(outside).toContainText('Outside current view')
  await outside.click()
  await expect(page.locator(`.ov-card[data-entity-id="${fixtureId(5)}"]`)).toHaveCount(1)
  await expect(page.locator('.ov')).toHaveAttribute('data-preset', 'operational')
  await page.getByRole('button', { name: '← Back', exact: true }).click()
  await expect(page.locator(`.ov-card[data-entity-id="${fixtureId(5)}"]`)).toHaveCount(0)
})

test('single-row toolbar Smart Search exact snippets, safe identifiers and explicit Initiative decisions', async ({ page }) => {
  const proofNow = Date.parse('2026-11-06T00:00:00Z')
  await page.clock.install({ time: proofNow })
  const scene = fixtureScene({ now: proofNow })
  for (const card of scene.cards) { delete card.source.properties.Initiative; card.ancestry = ['parent-only'] }
  const card = scene.cards.find(card => card.id === fixtureId(2))!
  card.source.properties.Initiative = { id: 'initiative', type: 'relation', value: ['explicit'], hasMore: false }
  card.source.properties['Will action'] = { id: 'will', type: 'multi_select', value: ['Decision', 'Merge'], hasMore: false }
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  await page.goto(base)
  await page.keyboard.press('Control+k')
  const input = page.getByRole('combobox', { name: 'Find names, IDs and text', exact: true })
  const results = page.getByRole('listbox', { name: 'Search results' })
  const initiative = page.getByRole('combobox', { name: 'Search initiative', exact: true })
  expect(await initiative.locator('option').evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value))).toEqual(['', 'explicit'])
  await initiative.selectOption('explicit')
  await page.getByRole('button', { name: 'Needs my decision', exact: true }).click()
  await expect(results.getByRole('option')).toHaveCount(1)
  await expect(results).toContainText(String(card.source.properties.Name!.value))
  await screenshot(page, 'smart-search-explicit-decision')
  await page.getByRole('button', { name: 'Remove initiative: explicit', exact: true }).click()
  await page.getByRole('button', { name: 'Remove pattern Needs my decision', exact: true }).click()
  // Deliver disposable source snapshots through the running browser's normal refresh.
  const text = '  PR #29201; PR #2920 then oﬃce release'
  for (const field of ['identifier', 'name', 'body']) {
    scene.searchIndex = { notes: ['Disposable authorized source snapshot'], documents: [{ key: `card:${card.id}`, target: { kind: 'card', id: card.id }, title: field === 'name' ? text : 'NEM3', identifiers: field === 'identifier' ? [text, '0143'] : ['0143'], fields: [{ name: field === 'name' ? 'Name' : 'Description', source: 'Notion blocks', text: field === 'identifier' ? 'Known PR' : text }], observedAt: new Date(proofNow).toISOString(), expiresAt: new Date(proofNow + 60_000).toISOString(), coverage: 'fresh/complete' }] }
    await page.reload()
    await page.keyboard.press('Control+k')
    await input.fill('"PR #2920"')
    await expect(results.getByRole('option')).toHaveCount(1)
    expect(await results.locator('mark').allTextContents()).toEqual('PR #2920'.split(''))
    await input.fill('29201x')
    await expect(results.getByRole('option')).toHaveCount(0)
    await input.fill('0142')
    await expect(results.getByRole('option')).toHaveCount(0)
    await input.fill('0143')
    await expect(results.getByRole('option')).toHaveCount(1)
    if (field !== 'identifier') {
      await input.fill('office')
      expect(await results.locator('mark').allTextContents()).toEqual('oﬃce'.split(''))
    }
  }
  await screenshot(page, 'smart-search-unicode-snippet')
})

test('single-row toolbar Smart Search patterns, evidence and mobile keyboard remain accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const proofNow = Date.parse('2026-11-06T00:00:00Z')
  await page.clock.install({ time: proofNow })
  const scene = fixtureScene({ now: proofNow })
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: [], attention: [], errors: [] } } }))
  await page.goto(base)
  await page.getByRole('button', { name: 'Smart Search (Ctrl or Command K)', exact: true }).click()
  const panel = page.getByRole('region', { name: 'Smart Search', exact: true })
  expect(await panel.getByRole('combobox', { name: 'Find names, IDs and text', exact: true }).evaluate(element => { const rect = element.getBoundingClientRect(); return document.elementFromPoint(rect.left + 4, rect.top + rect.height / 2) === element })).toBe(true)
  await expect(panel.getByRole('button', { name: 'Stalled · unavailable', exact: true })).toBeDisabled()
  await expect(panel.getByRole('button', { name: 'Stale · unavailable', exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: 'Blocked', exact: true }).click()
  await panel.getByRole('combobox', { name: 'Search machine', exact: true }).selectOption('Hulk')
  await expect(page.getByRole('button', { name: 'Remove machine: Hulk', exact: true })).toHaveCount(1)
  await expect(panel.getByRole('combobox', { name: 'Search machine', exact: true })).toHaveValue('Hulk')
  await expect(panel.getByRole('listbox')).toContainText('Waiting for input')
  await panel.getByText(/Why matched\?/).click()
  await expect(panel).toContainText('Input from reviewer')
  await screenshot(page, 'smart-search-phone-pattern')
  const bounds = await panel.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await panel.getByRole('button', { name: 'Apply filters', exact: true }).click()
  await expect(page.locator('.ov-card')).toHaveCount(1)
  await expect(page.locator('.ov-execution')).toHaveCount(1)
  await page.reload()
  await expect(page.locator('.ov-card')).toHaveCount(1)
  await page.getByRole('button', { name: 'Clear Smart Search', exact: true }).click()
  await expect(page.locator('.ov-card')).toHaveCount(5)
})

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
  await expect(page.getByLabel('Outer grouping')).toHaveValue('initiative')
  await expect(page.getByLabel('Inner grouping')).toHaveValue('status')
  await expect(page.getByLabel('Status preset')).toHaveValue('operational')
  await expect(page.locator('.ov-execution')).toHaveCount(5)
  await expect(page.locator('.ov-card')).toHaveCount(5)
  await expect(page.getByLabel('Fields', { exact: true })).toHaveCount(0)
  const active = page.locator('.ov-group').filter({ has: page.locator('.ov-group-name', { hasText: /^In Progress$/ }) })
  await expect(active.locator('.ov-execution')).toHaveCount(2)
  await expect(active.locator('.ov-card')).toHaveCount(4)
  await page.getByLabel('Inner grouping').selectOption('none')
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
  const candidate = page.locator('.ov-execution').filter({ hasText: 'Candidate relationship' })
  await expect(candidate.locator('..').locator('..').locator('.ov-empty-col')).toHaveText('Task link unverified')
  await expect(candidate.locator('..').locator('..').locator('.ov-gutter')).toHaveText('unverified')
  await expect(linked).toHaveCount(0)
  await expect(page.locator('.ov-execution')).toHaveCount(5)
  await page.getByRole('button', { name: 'Fields', exact: true }).click()
  await page.getByRole('button', { name: 'Worker Machine' }).click()
  await page.getByRole('group', { name: 'Place Machine' }).getByRole('button', { name: 'outer' }).click()
  await expect(page.getByLabel('Outer grouping')).toHaveValue('machine')
  await screenshot(page, 'controlled-shared-floor')
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect(page.getByLabel('Status preset')).toHaveValue('operational')
  await expect(page.getByLabel('Outer grouping')).toHaveValue('initiative')
  await expect(page.getByLabel('Inner grouping')).toHaveValue('status')
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
  await page.getByLabel('Inner grouping').selectOption('none')
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
  await task.click()
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
  await page.getByLabel('Outer grouping').selectOption('machine')
  expect(await task.locator('.ov-record-top,.ov-task-meta,.ov-record-foot,.ov-context-field').allTextContents()).toEqual(fields)
  // Expire the observations, preserving recorded execution status and legibility.
  await page.clock.fastForward(61_001)
  await expect(running.locator('.status-running')).toBeVisible()
  await expect(running.locator('.ov-freshness')).toHaveAttribute('aria-label', 'Last known observation')
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
  const scene = fixtureScene({ now })
  for (const card of scene.cards) {
    card.source.properties.Initiative = { id: 'initiative', type: 'select', hasMore: false, value: 'Delivery' }
    card.source.properties.Epic = { id: 'epic', type: 'select', hasMore: false, value: 'Readability' }
    card.source.properties.Priority = { id: 'priority', type: 'select', hasMore: false, value: 'High' }
  }
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.goto(base)
  await page.getByLabel('Outer grouping').selectOption('initiative')
  await page.getByLabel('Inner grouping').selectOption('status')
  await expect(page.locator('.ov-headings')).toHaveText('WORKERSRELATIONSHIPSNOTION TASKS')
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


test('independent endpoint order survives many-to-many relationships in both directions', async ({ page }) => {
  const now = Date.parse('2026-11-04T17:00:00Z')
  await page.clock.install({ time: now })
  const scene = fixtureScene({ now })
  const first = scene.claims.find(c => c.cardId === fixtureId(1))!
  scene.claims.push({ ...first, id: 'additional-task', cardId: fixtureId(6) })
  for (const [id, hour] of [[1, 12], [4, 13], [6, 14]]) scene.cards.find(c => c.id === fixtureId(id!))!.source.properties['Next check-in'] = { id: 'check', type: 'date', hasMore: false, value: { start: `2026-11-04T${hour}:00:00Z` } }
  scene.executions.find(w => w.identity.task_id === 'untracked-worker')!.source.last_event.age_seconds = 0
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.goto(base)
  await page.getByLabel('Outer grouping').selectOption('none')
  await page.getByLabel('Inner grouping').selectOption('none')
  const { organizedGroups } = await import('../src/shared/floorOrganization')
  const { initialPresentation } = await import('../src/reconciliation/presentation')
  for (const order of ['activity', 'checkIn'] as const) {
    await page.getByLabel('Order by').selectOption(order)
    for (const direction of ['asc', 'desc'] as const) {
      const desired = organizedGroups(scene, { ...initialPresentation(), organizer: { outer: 'none', inner: 'none', order, direction } }, now)[0]!
      await expect(page.locator('.ov')).toHaveAttribute('data-direction', direction)
      expect(await page.locator('.ov-execution').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-entity-id')))).toEqual(desired.workers.map(w => w.id))
      expect(await page.locator('.ov-card').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-entity-id')))).toEqual(desired.cards.map(c => c.id))
      await page.getByRole('button', { name: 'Reverse sort direction' }).click()
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
  await expect(page.locator('.ov-line.ov-linked')).toHaveCount(2)
  const card = page.locator(`.ov-card[data-entity-id="${fixtureId(1)}"]`)
  await expect(card).not.toContainText('First Mate tasks')
  await card.click()
  await expect(page.getByLabel('Inspector')).toContainText('Connections & history')
  await page.getByText('Evidence & diagnostics', { exact: true }).click()
  await expect(page.getByLabel('Inspector')).toContainText('notion.First Mate tasks')
  await screenshot(page, 'notion-owned-confirmed-links-fixture')
})

import { buildWorkerLinkReport } from '../src/server/reconciliation/workerLinkReport'
import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createTunnelFacade } from '../src/server/reconciliation/tunnel'
import { randomBytes } from 'node:crypto'
import { ReconciliationMcp } from '../src/server/reconciliation/mcp'
import { fixtureScene, fixtureQueue, fixtureId, fixtureSources } from '../test-fixtures/reconciliation/scenes'
import { seedOriginAllowlist } from '../src/server/api/originAllowlist'

let facadeServer: Server
let server: Server, root: string, base: string, client: Client
const scene = fixtureScene()
const queue = fixtureQueue()
// Explicit conditional acceptance fixture. Live proof uses the real source card.
const dirtId = '40c50ce6d422810db781cb306164584f'
const dirtTitle = 'Dirt Computing — Slice 2: game-like activity, queue explanations & Harvest Report'
const dirtCard = structuredClone(scene.cards.find(card => card.id === fixtureId(5))!)
dirtCard.id = dirtId; dirtCard.source.id = dirtId; dirtCard.source.url = `https://www.notion.so/${dirtId}`
dirtCard.source.properties.Name!.value = dirtTitle
scene.cards.push(dirtCard)
queue.items.push({ ...structuredClone(queue.items.find(item => item.cardIds.includes(fixtureId(5)))!), id: `card:${dirtId}`, title: dirtTitle, cardIds: [dirtId] })
const transcript: unknown[] = []
async function call(name: string, args: Record<string, unknown>) {
  const raw = await client.callTool({ name, arguments: args })
  const value = JSON.parse((raw.content as Array<{ text: string }>)[0]!.text)
  transcript.push({ name, arguments: args, response: value })
  return value
}
async function windowId(page: Page) { await expect(page.locator('[data-presentation-scene][data-scene-id], .ov[data-scene-id]')).toBeVisible(); return (await page.locator('[data-presentation-scene], .ov').getAttribute('data-scene-id'))! }
async function present(page: Page, action: unknown, command_id: string) {
  const scene_id = await windowId(page)
  // Initial queue loading can advance the browser after it registers. Read the
  // committed revision after its heartbeat reaches MCP before issuing a command.
  let current = await call('get_scene', { scene_id })
  await expect.poll(async () => {
    current = await call('get_scene', { scene_id })
    return current.state.revision === Number(await page.locator('[data-presentation-scene], .ov').getAttribute('data-revision'))
  }).toBe(true)
  const args = { scene_id, command_id, expected_revision: current.state.revision, action }
  let ack = await call('present_view', args)
  if (ack.outcome === 'queued') {
    await expect.poll(async () => { ack = await call('get_command', { scene_id, command_id }); return ack.outcome }).toBe('applied')
  }
  expect(ack.outcome).toBe('applied')
  return { ack, args }
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
// These regressions exercise the preserved rich presentation.
test('session code remains accessible after reveal with Discuss open', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`${base}/?view=floor`)
  await expect(page.getByRole('button', { name: 'Collapse Discuss', exact: true })).toBeVisible()
  await present(page, { type: 'reveal-search', target: { kind: 'card', id: fixtureId(1) }, targets: [{ kind: 'card', id: fixtureId(4) }] }, 'toolbar-reveal')
  const summary = page.locator('.ov-toolbar .session-connection summary')
  await expect(summary).toHaveAttribute('aria-label', /^ChatGPT tab [A-Z0-9]+$/)
  const geometry = await summary.evaluate(node => {
    const rect = node.getBoundingClientRect()
    const toolbar = node.closest('.ov-toolbar')!.getBoundingClientRect()
    return {
      contained: rect.left >= toolbar.left && rect.right <= toolbar.right,
      accessible: [rect.left + 2, rect.left + rect.width / 2, rect.right - 2].every(x => {
        const hit = document.elementFromPoint(x, rect.top + rect.height / 2)
        return !!hit && (hit === node || node.contains(hit))
      }),
      height: toolbar.height,
    }
  })
  expect(geometry).toEqual({ contained: true, accessible: true, height: 48 })
  await summary.click()
  await expect(page.getByRole('button', { name: 'Use this tab with ChatGPT', exact: true })).toBeVisible()
})

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { if (!localStorage.getItem('tinstar.overview.density')) localStorage.setItem('tinstar.overview.density', 'detailed') })
})

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tinstar-mcp-browser-'))
  const mcp = new ReconciliationMcp({ workerLinkReport: async () => buildWorkerLinkReport(fixtureSources()), scene: async () => scene, card: async () => ({ outcome: 'available', blocks: [{ id: 'context', text: 'Controlled card prose' }] }), queue: async () => queue }, root)
  server = createServer(async (req, res) => {
    if (await mcp.handle(req, res)) return
    const path = (req.url ?? '/').split('?')[0]!
    if (path === '/api/reconciliation/scene') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data: scene })); return }
    if (path === '/api/reconciliation/queue') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data: queue })); return }
    if (path === '/api/fleet') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data: { ready: true, workers: [], attention: [], errors: [] } })); return }
    if (path.startsWith('/api/')) { res.writeHead(404); res.end(); return }
    const file = path.startsWith('/assets/') && !path.includes('..') ? join(process.cwd(), 'dist/client', path) : join(process.cwd(), 'dist/client/index.html')
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream')
    createReadStream(file).pipe(res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  seedOriginAllowlist(port)
  base = `http://127.0.0.1:${port}`
  const callerToken = randomBytes(32).toString('hex')
  const facade = createTunnelFacade({ upstreamPort: port, installToken: (await readFile(join(root, 'mcp-token'), 'utf8')).trim(), caller: { id: 'controlled-browser-proof', token: callerToken, allowView: true } })
  facadeServer = facade.server
  await facade.listen(0)
  const facadePort = (facadeServer.address() as { port: number }).port
  client = new Client({ name: 'tinstar-playwright-proof', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${facadePort}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${callerToken}` } } }))
})
test.afterAll(async () => {
  await client?.close()
  await new Promise<void>(resolve => facadeServer?.close(() => resolve()))
  await new Promise<void>(resolve => server?.close(() => resolve()))
  await rm(root, { recursive: true, force: true, maxRetries: 3 })
})

test('Smart Search drafts preserve MCP organizer-group selections and saved search on dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`${base}/?view=floor`)
  const scene_id = await windowId(page)
  await present(page, { type: 'set-organizer', organizer: { outer: 'status', inner: 'machine', order: 'operational', direction: 'asc' } }, 'search-organizer')
  const search = { query: 'Waiting', patterns: [], facets: [] }
  await present(page, { type: 'set-search', search }, 'saved-search')
  for (const level of ['id', 'outerId']) {
    for (const exit of ['Escape', 'Close']) {
      const current = await call('get_scene', { scene_id })
      const group = current.records.groups.find((group: { cardIds: string[] }) => group.cardIds.length)
      expect(group).toBeTruthy()
      const target = { kind: 'group', id: group[level] }
      await present(page, { type: 'focus', target }, `focus-${level}-${exit}`)
      const beforeDraft = await page.locator('.ov-card').count()
      await page.keyboard.press('Control+k')
      await page.getByRole('combobox', { name: 'Find names, IDs and text', exact: true }).fill('no-such-record')
      await expect(page.getByLabel('Inspector', { exact: true })).toBeVisible()
      await expect(page.getByRole('status').filter({ hasText: 'No matches in available records.' })).toBeVisible()
      await expect(page.locator('.ov-card')).toHaveCount(beforeDraft)
      if (exit === 'Escape') await page.keyboard.press('Escape')
      else await page.getByRole('button', { name: 'Close search palette', exact: true }).click()
      await expect.poll(async () => (await call('get_scene', { scene_id })).state.selection).toEqual(target)
      const restored = await call('get_scene', { scene_id })
      expect(restored.state.search).toEqual(search)
      expect(restored.records.groups.some((group: Record<string, unknown>) => group[level] === target.id)).toBe(true)
      await expect(page.locator('.ov-card').first()).toBeVisible()
    }
  }
  const directory = process.env.TINSTAR_MCP_PROOF
  if (directory) {
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: join(directory, 'smart-search-group-restored.png'), fullPage: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(directory, 'smart-search-group-transcript.json'), JSON.stringify(transcript, null, 2))
  }
})

test('real MCP client gets browser-applied acks, isolates windows, and respects manual input and expiry', async ({ page, context }) => {
  await page.goto(`${base}/?view=floor`)
  const first = await windowId(page)
  const secondPage = await context.newPage()
  await secondPage.goto(`${base}/?view=floor`)
  const second = await windowId(secondPage)
  expect(first).not.toBe(second)
  const sessions = await call('list_ui_sessions', {})
  expect(sessions.sessions.map((s: { scene_id: string }) => s.scene_id)).toEqual(expect.arrayContaining([first, second]))
  await call('read_record', { scene_id: first, target: { kind: 'execution', id: scene.executions[0]!.id }, evidence: true })
  const card = await call('get_card_context', { scene_id: first, card_id: scene.cards[0]!.id })
  expect(card.context.blocks[0].text).toBe('Controlled card prose')
  const regroup = await present(page, { type: 'set-arrangement', arrangement: 'machine' }, 'regroup')
  await expect(page.locator('.ov')).toHaveAttribute('data-arrangement', 'machine')
  await expect(secondPage.locator('.ov')).toHaveAttribute('data-arrangement', 'initiative')
  const retry = await call('present_view', regroup.args)
  expect(retry).toEqual(regroup.ack)
  const organizer = { outer: 'status', inner: 'machine', order: 'checkIn', direction: 'desc' }
  await present(page, { type: 'set-organizer', organizer }, 'shared-organizer')
  await expectAdvanced(page, 'Outer grouping', 'status')
  await expectAdvanced(page, 'Inner grouping', 'machine')
  await expect(page.locator('.ov')).toHaveAttribute('data-direction', 'desc')
  const grouped = await call('get_scene', { scene_id: first })
  expect(grouped.records.groups.filter((g: { cardIds: string[] }) => g.cardIds.includes(fixtureId(1)))).toHaveLength(2)
  const group = grouped.records.groups.find((g: { cardIds: string[] }) => g.cardIds.includes(fixtureId(1)))
  expect((await call('read_record', { scene_id: first, target: { kind: 'group', id: group.id } })).outcome).toBe('available')
  await present(page, { type: 'set-status-filter', filter: { preset: 'all', statuses: [] } }, 'all-cards')
  await expectAdvanced(page, 'Status preset', 'all')
  await expectAdvanced(secondPage, 'Status preset', 'operational')
  await present(page, { type: 'set-sort', sort: 'activity' }, 'sort-activity')
  await present(page, { type: 'set-sort', sort: 'priority' }, 'sort-priority')
  await present(page, { type: 'set-links', visible: false }, 'hide-links')
  await expect(page.locator('.ov-connections')).toHaveCount(0)
  await present(page, { type: 'set-links', visible: true }, 'show-links')
  await present(page, { type: 'focus', target: { kind: 'card', id: scene.cards[0]!.id } }, 'focus')
  await expect(page.getByLabel('Inspector', { exact: true })).toContainText(scene.cards[0]!.id)
  const linkedCardId = fixtureId(1)
  const linkedClaim = scene.claims.find(c => c.cardId === linkedCardId && c.verification === 'confirmed')!
  await present(page, { type: 'set-exceptions', enabled: true }, 'exceptions-before-flash')
  await expect(page.locator(`[data-entity-id="${linkedCardId}"]`)).toHaveCount(0)
  const flashed = await present(page, { type: 'flash', targets: [{ kind: 'card', id: linkedCardId }, { kind: 'execution', id: linkedClaim.executionId }, { kind: 'claim', id: linkedClaim.id }], durationMs: 4000 }, 'flash')
  expect(flashed.ack.state.exceptionsOnly).toBe(false)
  expect(flashed.ack.state.selection).toEqual({ kind: 'card', id: scene.cards[0]!.id })
  const linkedRow = page.locator(`[data-entity-id="${linkedCardId}"]`).first()
  await expect(linkedRow).toBeVisible()
  await expect(page.locator('.ov-card.flashed').first()).toBeVisible()
  // Horizontal SVG paths have a zero-height box despite a visible stroke.
  const flashedLine = page.locator('.ov-line.flashed').first()
  await expect(flashedLine).toBeAttached()
  expect(await flashedLine.evaluate(node => { const style = getComputedStyle(node); return style.stroke !== 'none' && Number(style.strokeWidth.replace('px', '')) > 0 && style.visibility === 'visible' })).toBe(true)
  await expect(page.getByRole('status').filter({ hasText: 'Assistant changed this view' })).toBeVisible()
  await present(page, { type: 'open-queue' }, 'open-desk')
  const beforeNext = await call('get_scene', { scene_id: first })
  expect(beforeNext.state.queueItemId).toBe(queue.items[0]!.id)
  let nextAck = await call('next_queue_item', { scene_id: first, command_id: 'next', expected_revision: beforeNext.state.revision })
  if (nextAck.outcome === 'queued') await expect.poll(async () => { nextAck = await call('get_command', { scene_id: first, command_id: 'next' }); return nextAck.outcome }).toBe('applied')
  expect(nextAck.outcome).toBe('applied')
  await expect(page.getByLabel('Selected decision')).toHaveAttribute('data-decision-id', queue.items[1]!.id)
  expect((await call('get_queue', { scene_id: first })).items[0].readiness).toBe('ready-now')
  await present(page, { type: 'clear-transient' }, 'clear-flash-before-navigation')
  await present(page, { type: 'set-status-filter', filter: { preset: 'custom', statuses: ['Waiting For'] } }, 'hide-desk-task')
  await expect(page.locator(`.ov-card[data-entity-id="${linkedCardId}"]`)).toHaveCount(0)
  const navigation = await present(page, { type: 'navigate-card', cardId: linkedCardId }, 'navigate-desk-task')
  expect(navigation.ack.state.selection).toEqual({ kind: 'card', id: linkedCardId })
  expect(navigation.ack.state.navigation.cardId).toBe(linkedCardId)
  expect(navigation.ack.state.queueItemId).toBe(queue.items[1]!.id)
  expect(navigation.ack.state.statusFilter).toEqual({ preset: 'custom', statuses: ['Waiting For'] })
  await expect(page).toHaveURL(/view=decisions/)
  await expect(page.locator(`.decisions-row[data-card-id="${linkedCardId}"]`).first()).toHaveClass(/selected/)
  expect(await windowId(page)).toBe(first)
  // Return manually before exercising the Overview organizer race.
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  await expect(page.locator('.ov')).toBeVisible()
  await expect.poll(async () => (await call('get_scene', { scene_id: first })).state.revision).toBe(Number(await page.locator('.ov').getAttribute('data-revision')))
  const revision = (await call('get_scene', { scene_id: first })).state.revision
  expect((await call('present_view', { scene_id: first, command_id: 'unknown', expected_revision: revision, action: { type: 'focus', target: { kind: 'card', id: 'unknown' } } })).outcome).toBe('unknown-id')
  // Hold command delivery; a direct click occurs after enqueue and before receipt.
  let resume: (() => void) | undefined
  let held = false
  await page.route('**/api/reconciliation/ui', async route => {
    if (route.request().postDataJSON().type === 'sync' && !held) { held = true; await new Promise<void>(resolve => { resume = resolve }) }
    await route.continue()
  })
  await expect.poll(() => held).toBe(true)
  const competing = call('present_view', { scene_id: first, command_id: 'competing', expected_revision: revision, action: { type: 'set-arrangement', arrangement: 'initiative' } })
  await selectAdvanced(page, 'Outer grouping', 'manager')
  resume!()
  let competingAck = await competing
  if (competingAck.outcome === 'queued') await expect.poll(async () => { competingAck = await call('get_command', { scene_id: first, command_id: 'competing' }); return competingAck.outcome }).toBe('stale-revision')
  expect(competingAck.outcome).toBe('stale-revision')
  await expect(page.locator('.ov')).toHaveAttribute('data-outer', 'manager')
  await page.unroute('**/api/reconciliation/ui')
  // A command which never reaches the UI expires, rather than claiming applied.
  await page.route('**/api/reconciliation/ui', route => route.abort())
  const current = await call('get_scene', { scene_id: first })
  const expiring = await call('present_view', { scene_id: first, command_id: 'expire', expected_revision: current.state.revision, ttl_ms: 500, action: { type: 'set-exceptions', enabled: true } })
  expect(expiring.outcome).toBe('expired')
  await page.unroute('**/api/reconciliation/ui')
  await secondPage.close()
  await expect.poll(async () => (await call('get_scene', { scene_id: second })).outcome, { timeout: 15_000 }).toBe('disconnected')
  const disconnected = await call('present_view', { scene_id: second, command_id: 'offline', expected_revision: 0, action: { type: 'clear-transient' } })
  expect(disconnected.outcome).toBe('disconnected')
  const directory = process.env.TINSTAR_MCP_PROOF
  if (directory) {
    await mkdir(directory, { recursive: true })
    await page.screenshot({ path: join(directory, 'controlled-mcp-browser.png'), fullPage: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(directory, 'controlled-mcp-transcript.json'), JSON.stringify(transcript, null, 2))
  }
})

test('Decisions shares conditional selection and visible MCP flashes on desktop and phone in the same scene', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  // Put the conditional target far below the fold without changing source identity.
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: { ...queue, items: [
    ...queue.items.filter(item => !item.cardIds.includes(dirtId)),
    ...Array.from({ length: 35 }, (_, index) => ({ ...queue.items[0]!, id: `unlinked:${index}`, cardIds: [], title: `Additional request ${index}`, evidence: [] })),
    queue.items.find(item => item.cardIds.includes(dirtId))!,
  ] } } }))
  await page.goto(`${base}/?view=decisions`)
  let scene_id = await windowId(page)
  const row = page.locator(`.decisions-row[data-card-id="${dirtId}"]`)
  const search = page.getByRole('searchbox', { name: 'Search decisions' })
  await search.fill('Dirt Computing')
  await expect(row).toContainText('Waiting on a prerequisite')
  await row.click()
  await expect.poll(async () => (await call('get_scene', { scene_id })).state.selection).toEqual({ kind: 'card', id: dirtId })
  await expect(page.getByLabel('Selected decision')).toContainText(dirtTitle)
  const revision = (await call('get_scene', { scene_id })).state.revision
  const missing = await call('present_view', { scene_id, command_id: 'decisions-missing', expected_revision: revision, action: { type: 'flash', targets: [{ kind: 'card', id: 'missing' }] } })
  expect(missing.outcome).toBe('unknown-id')
  await page.getByRole('button', { name: 'Overview', exact: true }).click()
  expect(await windowId(page)).toBe(scene_id)
  await page.goBack()
  await expect(search).toHaveValue('Dirt Computing')
  expect(await windowId(page)).toBe(scene_id)
  await page.goForward()
  await expect(page.getByRole('region', { name: 'Overview', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Decisions', exact: true }).click()
  expect(await windowId(page)).toBe(scene_id)
  await page.reload()
  scene_id = await windowId(page)
  await expect(row).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await call('get_scene', { scene_id })).state.selection).toEqual({ kind: 'card', id: dirtId })
  const list = page.getByLabel('Decision requests')
  await list.evaluate(node => { node.scrollTop = 0 })
  await expect(row).not.toBeInViewport()
  await present(page, { type: 'focus', target: { kind: 'card', id: fixtureId(1) } }, 'decisions-focus-other')
  await present(page, { type: 'flash', targets: [{ kind: 'card', id: dirtId }], durationMs: 4000 }, 'decisions-visible-flash')
  await expect(row).toHaveClass(/flashed/)
  await expect(row).toBeInViewport()
  await expect(row).toHaveAttribute('aria-pressed', 'false')
  await expect(page).toHaveURL(/view=decisions/)
  const directory = process.env.TINSTAR_MCP_PROOF
  if (directory) await page.screenshot({ path: join(directory, 'decisions-desktop-flash.png'), fullPage: true })
  await expect(row).not.toHaveClass(/flashed/, { timeout: 6000 })
  await expect.poll(() => list.evaluate(node => node.scrollTop)).toBe(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await row.click()
  await expect(page.getByLabel('Selected decision')).toBeVisible()
  await expect(list).toBeHidden()
  await page.getByRole('button', { name: /All decisions/ }).click()
  await expect(list).toBeVisible()
  await expect(page.getByLabel('Selected decision')).toBeHidden()
  await search.fill('no matching title')
  await present(page, { type: 'focus', target: { kind: 'card', id: dirtId } }, 'decisions-phone-focus')
  await present(page, { type: 'flash', targets: [{ kind: 'card', id: dirtId }], durationMs: 4000 }, 'decisions-phone-flash')
  await expect(row).toBeInViewport()
  await expect(row).toHaveClass(/selected.*flashed/)
  await expect(search).toHaveValue('no matching title')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  if (directory) {
    await page.screenshot({ path: join(directory, 'decisions-phone-flash.png'), fullPage: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(directory, 'decisions-mcp-transcript.json'), JSON.stringify(transcript, null, 2))
  }
  // A manual click advances the same revision and owns the shared focus.
  await search.fill('Build live')
  await page.locator(`.decisions-row[data-card-id="${fixtureId(1)}"]`).click()
  await expect.poll(async () => (await call('get_scene', { scene_id })).state.selection).toEqual({ kind: 'card', id: fixtureId(1) })
})

test('Decisions header controls remain separate at workbench viewport sizes', async ({ page }) => {
  await page.goto(`${base}/?view=decisions`)
  await windowId(page)
  for (const [width, height, pane] of [[1040, 900, 'desktop'], [1440, 900, 'desktop'], [390, 844, 'queue'], [390, 844, 'detail']] as const) {
    await page.setViewportSize({ width, height })
    if (pane === 'detail') await page.locator('.decisions-row').first().click()
    const connection = page.locator('.decisions-top .session-connection > summary')
    const source = page.locator('.decisions-source > summary')
    const brand = page.getByRole('heading', { name: 'Decisions', exact: true })
    const boxes = await Promise.all([brand.boundingBox(), connection.boundingBox(), source.boundingBox()])
    for (const box of boxes) {
      expect(box).not.toBeNull()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
    }
    expect(boxes[0]!.x + boxes[0]!.width).toBeLessThanOrEqual(boxes[1]!.x)
    expect(boxes[1]!.x + boxes[1]!.width).toBeLessThanOrEqual(boxes[2]!.x)
    await source.click()
    await expect(page.getByRole('heading', { name: 'Source health' })).toBeVisible()
    await source.click()
    await connection.click()
    await expect(page.getByRole('button', { name: 'Copy session ID', exact: true })).toBeVisible()
    await connection.click()
    const directory = process.env.TINSTAR_MCP_PROOF
    if (directory) await page.screenshot({ path: join(directory, `fixed-workbench-${width}-${pane}.png`) })
  }
})

test('Decisions reports unavailable sources and never acknowledges a flash without a visible source row', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => sessionStorage.setItem('tinstar-decision-request', 'retained-request'))
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ status: 503, json: { ok: false } }))
  await page.goto(`${base}/?view=decisions`)
  const scene_id = await windowId(page)
  await page.getByText('Some sources need verification', { exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Requests could not refresh' })).toBeVisible()
  await expect(page.locator('.decisions-row')).toHaveCount(0)
  await expect(page.getByText('Decision sources are unavailable.')).toBeVisible()
  const current = await call('get_scene', { scene_id })
  let ack = await call('present_view', { scene_id, command_id: 'decisions-unavailable-flash', expected_revision: current.state.revision, action: { type: 'flash', targets: [{ kind: 'card', id: dirtId }] } })
  if (ack.outcome === 'queued') await expect.poll(async () => { ack = await call('get_command', { scene_id, command_id: 'decisions-unavailable-flash' }); return ack.outcome }).toBe('queue-source-unavailable')
  expect(ack.outcome).toBe('queue-source-unavailable')
  await expect(page).toHaveURL(/view=decisions/)
  const directory = process.env.TINSTAR_MCP_PROOF
  if (directory) await page.screenshot({ path: join(directory, 'decisions-unavailable.png'), fullPage: true })
})

test('Decisions restores replaced and cleared flashes and keeps manual scroll ownership', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: { ...queue, items: [
    ...queue.items.filter(item => !item.cardIds.includes(dirtId)),
    ...Array.from({ length: 35 }, (_, index) => ({ ...queue.items[0]!, id: `scroll-request:${index}`, cardIds: [], title: `Scroll request ${index}`, evidence: [] })),
    queue.items.find(item => item.cardIds.includes(dirtId))!,
  ] } } }))
  await page.goto(`${base}/?view=decisions`)
  await windowId(page)
  const list = page.getByLabel('Decision requests')
  const row = page.locator(`.decisions-row[data-card-id="${dirtId}"]`)
  const positions = () => list.evaluate(node => {
    const result: number[][] = []
    for (let element: HTMLElement | null = node as HTMLElement; element; element = element.parentElement) result.push([element.scrollTop, element.scrollLeft])
    return result
  })
  await list.evaluate(node => { node.scrollTop = 40 })
  const original = await positions()
  await present(page, { type: 'flash', targets: [{ kind: 'card', id: dirtId }], durationMs: 4000 }, 'scroll-first')
  await expect(row).toBeInViewport()
  await present(page, { type: 'flash', targets: [{ kind: 'card', id: dirtId }], durationMs: 4000 }, 'scroll-replaced')
  await expect(row).toBeInViewport()
  await present(page, { type: 'clear-transient' }, 'scroll-cleared')
  await expect.poll(positions).toEqual(original)
  const restoredAfterClear = await positions()
  await present(page, { type: 'flash', targets: [{ kind: 'card', id: dirtId }], durationMs: 4000 }, 'scroll-manual')
  await expect(row).toBeInViewport()
  await list.dispatchEvent('wheel', { deltaY: -100 })
  await list.evaluate(node => { node.scrollTop = 120 })
  const owned = await positions()
  await present(page, { type: 'clear-transient' }, 'scroll-owned-clear')
  await expect.poll(positions).toEqual(owned)
  const directory = process.env.TINSTAR_MCP_PROOF
  if (directory) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(directory, 'decisions-scroll-transcript.json'), JSON.stringify({ original, restoredAfterClear, manualOwned: owned, final: await positions(), mcp: transcript }, null, 2))
  }
})

test('Decisions shows unknown actions, unlinked requests and stale coverage honestly', async ({ page }) => {
  const altered = structuredClone(queue)
  altered.items = [
    { ...altered.items[0]!, id: 'unknown-action-proof', cardIds: [fixtureId(4)], action: null, readiness: 'needs-readiness-verification', oneTouch: false },
    { ...altered.items[0]!, id: 'unlinked-proof', title: 'Unlinked recovery request', cardIds: [], evidence: [] },
  ]
  altered.coverage.intentions.status = 'stale'
  const ownershipScene = structuredClone(scene)
  ownershipScene.cards.find(card => card.id === fixtureId(4))!.nextAction = 'Will'
  await page.route('**/api/reconciliation/scene*', route => route.fulfill({ json: { ok: true, data: ownershipScene } }))
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: altered } }))
  await page.goto(`${base}/?view=decisions`)
  await windowId(page)
  await page.getByText('Some sources need verification', { exact: true }).click()
  await expect(page.getByText('Some evidence is stale or unavailable. Retained requests do not establish that all work is clear.')).toBeVisible()
  await page.locator(`.decisions-row[data-card-id="${fixtureId(4)}"]`).click()
  await expect(page.getByLabel('Selected decision')).toContainText('This request needs verification before you act.')
  await expect(page.locator(`.decisions-row[data-card-id="${fixtureId(4)}"]`)).not.toContainText('Will')
  await page.getByLabel('Decision requests').getByText('Unlinked recovery request', { exact: true }).click()
  await expect(page.getByLabel('Selected decision').getByRole('heading', { level: 2 })).toHaveText('Unlinked recovery request')
  await expect(page.getByLabel('Selected decision').getByRole('link', { name: 'Read Notion card' })).toHaveCount(0)
  const directory = process.env.TINSTAR_MCP_PROOF
  if (directory) await page.screenshot({ path: join(directory, 'decisions-stale-unlinked.png'), fullPage: true })
})

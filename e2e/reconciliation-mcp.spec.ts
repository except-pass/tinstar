import { test, expect, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ReconciliationMcp } from '../src/server/reconciliation/mcp'
import { fixtureScene } from '../test-fixtures/reconciliation/scenes'
import { seedOriginAllowlist } from '../src/server/api/originAllowlist'

let server: Server, root: string, base: string, client: Client
const scene = fixtureScene()
const transcript: unknown[] = []
async function call(name: string, args: Record<string, unknown>) {
  const raw = await client.callTool({ name, arguments: args })
  const value = JSON.parse((raw.content as Array<{ text: string }>)[0]!.text)
  transcript.push({ name, arguments: args, response: value })
  return value
}
async function windowId(page: Page) { await expect(page.locator('.floor[data-scene-id]')).toBeVisible(); return (await page.locator('.floor').getAttribute('data-scene-id'))! }
async function present(page: Page, action: unknown, command_id: string) {
  const scene_id = await windowId(page)
  const current = await call('get_scene', { scene_id })
  const args = { scene_id, command_id, expected_revision: current.state.revision, action }
  let ack = await call('present_view', args)
  if (ack.outcome === 'queued') {
    await expect.poll(async () => { ack = await call('get_command', { scene_id, command_id }); return ack.outcome }).toBe('applied')
  }
  expect(ack.outcome).toBe('applied')
  return { ack, args }
}
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tinstar-mcp-browser-'))
  const mcp = new ReconciliationMcp({ scene: async () => scene, card: async () => ({ outcome: 'available', blocks: [{ id: 'context', text: 'Controlled card prose' }] }), queue: async () => ({ outcome: 'queue-source-unavailable' }) }, root)
  server = createServer(async (req, res) => {
    if (await mcp.handle(req, res)) return
    const path = (req.url ?? '/').split('?')[0]!
    if (path === '/api/reconciliation/scene') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, data: scene })); return }
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
  client = new Client({ name: 'tinstar-playwright-proof', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${(await readFile(join(root, 'mcp-token'), 'utf8')).trim()}` } } }))
})
test.afterAll(async () => {
  await client?.close()
  await new Promise<void>(resolve => server?.close(() => resolve()))
  await rm(root, { recursive: true, force: true })
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
  await expect(page.locator('.floor')).toHaveAttribute('data-arrangement', 'machine')
  await expect(secondPage.locator('.floor')).toHaveAttribute('data-arrangement', 'initiative')
  const retry = await call('present_view', regroup.args)
  expect(retry).toEqual(regroup.ack)
  await present(page, { type: 'focus', target: { kind: 'card', id: scene.cards[0]!.id } }, 'focus')
  await expect(page.getByLabel('Scene inspector')).toContainText(scene.cards[0]!.id)
  await present(page, { type: 'flash', targets: [{ kind: 'card', id: scene.cards[0]!.id }], durationMs: 4000 }, 'flash')
  await expect(page.locator('.is-flashed').first()).toBeVisible()
  await expect(page.getByRole('status').filter({ hasText: 'Assistant changed this view' })).toBeVisible()
  const revision = (await call('get_scene', { scene_id: first })).state.revision
  expect((await call('present_view', { scene_id: first, command_id: 'unknown', expected_revision: revision, action: { type: 'focus', target: { kind: 'card', id: 'unknown' } } })).outcome).toBe('unknown-id')
  expect((await call('next_queue_item', { scene_id: first, command_id: 'next', expected_revision: revision })).outcome).toBe('queue-source-unavailable')
  // Hold command delivery; a direct click occurs after enqueue and before receipt.
  let resume: (() => void) | undefined
  let held = false
  await page.route('**/api/reconciliation/ui', async route => {
    if (route.request().postDataJSON().type === 'sync' && !held) { held = true; await new Promise<void>(resolve => { resume = resolve }) }
    await route.continue()
  })
  await expect.poll(() => held).toBe(true)
  const competing = call('present_view', { scene_id: first, command_id: 'competing', expected_revision: revision, action: { type: 'set-arrangement', arrangement: 'initiative' } })
  await page.getByRole('button', { name: 'Second Mate', exact: true }).click()
  resume!()
  let competingAck = await competing
  if (competingAck.outcome === 'queued') await expect.poll(async () => { competingAck = await call('get_command', { scene_id: first, command_id: 'competing' }); return competingAck.outcome }).toBe('stale-revision')
  expect(competingAck.outcome).toBe('stale-revision')
  await expect(page.locator('.floor')).toHaveAttribute('data-arrangement', 'secondMate')
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

import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fixtureSources } from '../test-fixtures/reconciliation/scenes'
import { SceneReconciler } from '../src/server/reconciliation/scene'
import { buildQueue } from '../src/server/reconciliation/queue'

test.use({ hasTouch: true })
let server: ChildProcess, root: string
const base = 'http://127.0.0.1:5293'
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tinstar-review-preview-'))
  await mkdir(join(root, 'config'))
  await writeFile(join(root, 'config', 'config.json'), JSON.stringify({ firstmate: { homes: [] }, reconciliation: { fleet: [] } }))
  const env: NodeJS.ProcessEnv = { ...process.env, TINSTAR_CONFIG_HOME: join(root, 'config'), TINSTAR_NO_SESSIONS: '1', TINSTAR_TELEMETRY: '0' }
  delete env.TINSTAR_DEPLOY_BLOCK
  server = spawn(process.execPath, ['dist/server/standalone.js', '--port', '5293', '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  server.stdout?.on('data', chunk => { output += String(chunk) }); server.stderr?.on('data', chunk => { output += String(chunk) })
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/deployment`)).ok) return } catch { /* Isolated preview starting. */ }
    if (server.exitCode !== null) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const log = join(process.env.TINSTAR_REVIEW_PROOF_DIR ?? tmpdir(), 'review-preview-start.log')
  await writeFile(log, output)
  throw new Error(`Preview failed to start; evidence retained at ${log}`)
})
test.afterAll(async () => {
  server?.kill()
  if (server && server.exitCode === null) await new Promise<void>(resolve => server.once('exit', () => resolve()))
  if (root) await rm(root, { recursive: true, force: true })
})

for (const mobile of [false, true]) test(`existing review drawer supports ${mobile ? 'touch' : 'keyboard'} acceptance and truthful coverage`, async ({ page }) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 })
  const source = fixtureSources(); source.fleet = []; const cards = source.intentions.data!.cards.slice(0, 2)
  for (const [index, card] of cards.entries()) {
    card.properties.Status!.value = 'Ready for Review'; card.properties.Owner!.value = index ? 'Will' : 'Firstmate'
    card.properties.Name!.value = index ? 'PRs UI acceptance (fixture child)' : 'Discuss and Decisions acceptance (fixture)'
    card.properties['Will action'] = { id: 'action', type: 'multi_select', hasMore: false, value: [] }
    card.properties['Waiting For'] = { id: 'wait', type: 'rich_text', hasMore: false, value: '' }
    card.properties.Link = { id: 'link', type: 'url', hasMore: false, value: `${base}/?page=${index ? 'pulls' : 'decisions'}` }
  }
  source.intentions.data!.cards = cards
  const queue = () => buildQueue(source)
  const writes: Array<Record<string, unknown>> = []
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: queue() } }))
  await page.route('**/api/reconciliation/scene*', route => route.fulfill({ json: { ok: true, data: new SceneReconciler().reconcile(source) } }))
  await page.route('**/api/reconciliation/workflow', async route => {
    const request = route.request().postDataJSON()
    if (request.operation !== 'update') return route.continue()
    writes.push(request.input)
    const card = cards.find(row => row.id === request.input.card_id)!
    card.properties.Status!.value = request.input.kind === 'accept_review' ? 'Done' : 'Queued'
    await route.fulfill({ json: { ok: true, data: { outcome: 'saved', code: 'review-saved', message: 'Review response recorded', operation_id: request.input.operation_id, saved_fields: ['Status', 'Owner', 'note'] } } })
  })
  await page.goto(base)
  const trigger = page.getByRole('button', { name: /Review Ready/ })
  if (mobile) await trigger.tap()
  else { await trigger.focus(); await page.keyboard.press('Enter') }
  const panel = page.getByRole('complementary', { name: 'Review Ready' })
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('article')).toHaveCount(2)
  await expect(panel.getByRole('link', { name: 'Open live feature ↗' }).first()).toHaveAttribute('href', /page=decisions/)
  if (process.env.TINSTAR_REVIEW_PROOF_DIR) await page.screenshot({ path: join(process.env.TINSTAR_REVIEW_PROOF_DIR, `review-${mobile ? 'mobile' : 'desktop'}-before.png`), fullPage: true })
  const first = panel.getByRole('article').first()
  await first.getByRole('checkbox').check()
  if (!mobile) { await first.getByRole('button', { name: 'Approve deliverable' }).focus(); await page.keyboard.press('Enter') }
  else await first.getByRole('button', { name: 'Approve deliverable' }).tap()
  await expect(panel.getByRole('article')).toHaveCount(1)
  expect(writes[0]).toMatchObject({ kind: 'accept_review', scope_complete: true })
  await panel.getByLabel('Feedback', { exact: true }).fill('Please repair the mobile row spacing')
  await panel.getByRole('button', { name: 'Request changes' }).click()
  await expect(panel.getByRole('article')).toHaveCount(0)
  expect(writes[1]).toMatchObject({ kind: 'request_review_changes', feedback: 'Please repair the mobile row spacing' })
  if (process.env.TINSTAR_REVIEW_PROOF_DIR) await page.screenshot({ path: join(process.env.TINSTAR_REVIEW_PROOF_DIR, `review-${mobile ? 'mobile' : 'desktop'}-after.png`), fullPage: true })
  source.intentions.status = 'stale'
  await page.reload(); await trigger.click()
  await expect(panel.getByText(/Review coverage is incomplete or stale/)).toBeVisible()
  await expect(panel.getByText('Nothing needs you right now.')).toHaveCount(0)
  if (process.env.TINSTAR_REVIEW_PROOF_DIR) await page.screenshot({ path: join(process.env.TINSTAR_REVIEW_PROOF_DIR, `review-${mobile ? 'mobile' : 'desktop'}-coverage.png`), fullPage: true })
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await expect(trigger).toBeFocused()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})

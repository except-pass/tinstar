import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { AskApi } from '../src/server/ask/routes'
import { seedOriginAllowlist } from '../src/server/api/originAllowlist'
import { resolve } from 'node:path'
import { decideStaticServe } from '../src/server/staticServe'
import { fixtureId, fixtureScene } from '../test-fixtures/reconciliation/scenes'

// A real built client with isolated API fixtures; manual preview proof uses real sources.
let server: ReturnType<typeof createServer>, base: string
let liveAsk: AskApi | undefined
const client = resolve('dist/client')
test.beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (liveAsk && await liveAsk.handle(req, res)) return
    const decision = decideStaticServe((req.url ?? '/').split('?')[0]!, client, existsSync)
    if (decision.kind === 'file') { res.writeHead(200, { 'Content-Type': decision.mime }); res.end(readFileSync(decision.filePath)) }
    else if (decision.kind === 'spa') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(readFileSync(decision.indexPath)) }
    else { res.writeHead(404); res.end() }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
test.afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/quota') { await route.fulfill({ json: { providers: [], checkedAt: null, fetchedAt: null, commandError: null } }); return }
    const body = route.request().postDataJSON()
    const data = path === '/api/fleet' ? { ready: true, workers: [], attention: [], errors: [] }
      : path === '/api/fleet/messages' ? []
        : path === '/api/reconciliation/scene' ? { ...fixtureScene(), searchIndex: { documents: [], notes: [] } }
          : path === '/api/reconciliation/queue' ? { items: [] }
            : path === '/api/reconciliation/ui' ? body?.type === 'register' ? { scene_id: 'browser-fixture', key: 'key' } : { commands: [] }
              : path === '/api/ask/requests' ? [0, 1].map(index => ({ request_id: `00000000-0000-4000-8000-00000000000${index}`, conversation_id: `10000000-0000-4000-8000-00000000000${index}`, question: `Independent question ${index}`, input_mode: 'text', context: { anchor: { kind: 'work', page_id: fixtureId(1), label: 'Fixture task', url: null, observed_at: null }, view: { scene: 'overview' } }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'sent', reply: null, error: null, read_at: null, dismissed_at: null }))
                : path === '/api/releases' ? { pulls: [], unassociatedCards: [], warnings: [], associationsComplete: true, associationsWritable: false }
                  : path === '/api/pulls' ? { pulls: [], repositories: [], warnings: [], associationsComplete: true } : {}
    await route.fulfill({ json: { ok: true, data } })
  })
})
test('one persistent Desk across sections with pointer/keyboard sizing and reload preferences', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(base)
  const desk = page.getByRole('complementary', { name: 'Your desk' }), separator = page.getByRole('separator', { name: 'Resize Your desk' })
  await expect(desk.getByText('Independent question 0')).toBeVisible()
  await desk.evaluate(element => { (element as HTMLElement).dataset.mountWitness = 'same-desk' })
  const divider = (await separator.boundingBox())!
  await page.mouse.move(divider.x + 3, divider.y + 150); await page.mouse.down()
  await page.mouse.move(divider.x - 117, divider.y + 150); await page.mouse.up()
  await expect(separator).toHaveAttribute('aria-valuenow', '440')
  const nav = page.getByRole('navigation', { name: 'Activity' })
  for (const section of ['PRs', 'Releases', 'Overview']) {
    await nav.getByRole('button', { name: section === 'Releases' ? /^Releases/ : section, exact: section !== 'Releases' }).click()
    await expect(desk).toHaveAttribute('data-mount-witness', 'same-desk')
    await expect(separator).toHaveAttribute('aria-valuenow', '440')
    await expect(desk.getByText('Independent question 1')).toBeVisible()
  }
  await separator.focus(); await page.keyboard.press('ArrowLeft')
  await expect(separator).toHaveAttribute('aria-valuenow', '456')
  await desk.getByRole('button', { name: 'Collapse Your desk' }).click()
  await expect(desk).toBeHidden()
  await expect(page.getByRole('button', { name: /Open Your desk/ })).toBeFocused()
  await page.reload()
  await expect(page.getByRole('complementary', { name: 'Your desk' })).toBeHidden()
  await page.getByRole('button', { name: /Open Your desk/ }).click()
  await expect(separator).toHaveAttribute('aria-valuenow', '456')
  await page.setViewportSize({ width: 900, height: 900 })
  await expect(separator).toHaveAttribute('aria-valuenow', '438')
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(separator).toHaveAttribute('aria-valuenow', '456')
  await expect(page.locator('.ov-item').first()).toHaveCSS('min-height', '29px')
  await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true })
})
test('one accessible mobile sheet retains its inbox on close and section navigation', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(`${base}/?view=pulls`)
  const trigger = page.getByRole('button', { name: /Open Your desk/ })
  await expect(trigger).toHaveCount(1)
  await trigger.click()
  const sheet = page.getByRole('dialog', { name: 'Your desk' })
  await expect(sheet.getByText('Independent question 0')).toBeVisible()
  await sheet.evaluate(element => { (element as HTMLElement).dataset.mountWitness = 'mobile-desk' })
  await expect(sheet.getByRole('button', { name: 'Close Your desk' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden(); await expect(trigger).toBeFocused()
  await page.getByRole('navigation').getByRole('button', { name: /^Releases/ }).click()
  await trigger.click()
  await expect(sheet).toHaveAttribute('data-mount-witness', 'mobile-desk')
  await expect(sheet.getByText('Independent question 1')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true })
  await sheet.getByRole('button', { name: 'Find worker' }).click()
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('complementary', { name: 'Workers' })).toBeVisible()
})

test('typed CI Ask returns from Releases to its exact PR after an independent answer arrives', async ({ page }) => {
  const head = 'a'.repeat(40), at = new Date().toISOString(), requests: Record<string, unknown>[] = []
  const pull = { id: 'owner/repo#17', repository: 'owner/repo', number: 17, url: 'https://github.com/owner/repo/pull/17', title: 'Typed fixture PR', author: 'owner', draft: false, head, base: 'main', createdAt: at, updatedAt: at, observedAt: at, freshness: 'fresh', links: [] }
  let records: Array<Record<string, unknown>> = []
  await page.route('**/api/pulls**', async route => {
    const data = new URL(route.request().url()).pathname.endsWith('/detail') ? { head, state: 'open', body: 'CI evidence', bodyTruncated: false, additions: 2, deletions: 1, files: 1, checks: 'failed', review: 'Changes requested', reviews: [], reviewsComplete: true, freshness: 'fresh', observedAt: at, error: null } : { pulls: [pull, { ...pull, id: 'other/repo#17', repository: 'other/repo', url: 'https://github.com/other/repo/pull/17' }], repositories: [], warnings: [], associationsComplete: true }
    await route.fulfill({ json: { ok: true, data } })
  })
  await page.route('**/api/ask/requests', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON(); requests.push(body)
      const target = body.target
      const row = { request_id: '20000000-0000-4000-8000-000000000017', conversation_id: '20000000-0000-4000-8000-000000000017', question: body.question, input_mode: 'text', context: { schema_version: 2, anchor: { kind: 'pull', page_id: pull.id, label: 'Typed fixture PR', url: pull.url, observed_at: at }, target, view: body.view, return_to: { section: 'pulls', target, view: body.view }, field_key: 'ci', field_value: 'failed' }, created_at: at, updated_at: at, status: 'sent', reply: null, error: null, read_at: null, dismissed_at: null }
      records.push(row); await route.fulfill({ json: { ok: true, data: row } })
    } else await route.fulfill({ json: { ok: true, data: records } })
  })
  await page.route('**/api/ask/requests/*/read', async route => { await route.fulfill({ json: { ok: true, data: {} } }) })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${base}/?view=pulls`)
  await page.getByRole('button', { name: 'Inspect owner/repo#17', exact: true }).click()
  await page.locator('.pr-row[data-ask-origin="owner/repo#17"] [data-ask-field="ci"]').click({ button: 'right' })
  await expect(page.getByRole('textbox', { name: 'Question' })).toHaveValue('What is happening with CI for this PR?')
  expect(requests).toHaveLength(0)
  await page.getByRole('textbox', { name: 'Question' }).fill('Isolated fixture CI question')
  await page.getByRole('button', { name: 'Send question' }).click()
  await expect(page.getByText('Isolated fixture CI question', { exact: true })).toBeVisible()
  expect(requests[0]).toMatchObject({ target: { kind: 'pull', id: pull.id, head }, field_key: 'ci', view: { scene: 'pulls' } })
  expect(requests[0]).not.toHaveProperty('card_id')
  await page.getByRole('navigation').getByRole('button', { name: /^Releases/ }).click()
  records = records.map(row => ({ ...row, status: 'answered', reply: { summary: 'Isolated correlated answer', detail: 'Fixture evidence detail', references: [], suggested_actions: [] } }))
  await expect(page.getByText('Isolated correlated answer', { exact: true })).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: /New answer.*Isolated fixture CI question/ }).click()
  await expect(page.locator('.pr-row')).toHaveCount(1)
  await expect(page.locator('.pr-row.ask-origin')).toHaveAttribute('data-ask-origin', pull.id)
  await expect(page.getByRole('dialog')).toContainText('Isolated correlated answer')
  await page.getByRole('button', { name: 'Back to task' }).click()
  await page.goBack()
  await expect(page).toHaveURL(/view=releases/)
})

for (const mode of ['release', 'receipt', 'removed-target', 'wrong-component', 'changed-head'] as const) {
  test(`release origin resolves exact identity: ${mode}`, async ({ page }, testInfo) => {
    const at = new Date().toISOString(), id = 'owner/repo#17'
    const receipt = { id: 'receipt-1', version: 'v17', deployedSha: 'a'.repeat(40), deployedAt: at, receiptUrl: 'https://example.test/receipt', workflowUrl: 'https://example.test/workflow' }
    const targets = [{ component: 'web', target: 'production', state: 'unknown', reason: 'Pending', ancestry: 'unknown', receipt }, { component: 'api', target: 'production', state: 'unknown', reason: 'Pending', ancestry: 'unknown', receipt: mode === 'wrong-component' ? receipt : null }]
    if (mode === 'removed-target' || mode === 'wrong-component') targets.shift()
    const target = mode === 'changed-head' ? { kind: 'pull', id, head: 'a'.repeat(40) } : { kind: mode === 'receipt' || mode === 'wrong-component' ? 'receipt' : 'release', id, component: 'web', target: 'production', ...(mode === 'receipt' || mode === 'wrong-component' ? { receipt_id: 'receipt-1' } : {}) }
    await page.route('**/api/releases', route => route.fulfill({ json: { ok: true, data: { pulls: [{ id, repository: 'owner/repo', number: 17, url: 'https://github.com/owner/repo/pull/17', title: 'Release identity proof', head: 'b'.repeat(40), links: [], exceptions: [], state: 'open', mergedAt: null, mergeSha: null, observedAt: at, freshness: 'fresh', deployment: { state: 'in-queue', targets } }], unassociatedCards: [], warnings: [], associationsComplete: true, associationsWritable: false } } }))
    await page.route('**/api/ask/requests', route => route.fulfill({ json: { ok: true, data: [{ request_id: '20000000-0000-4000-8000-000000000017', conversation_id: '20000000-0000-4000-8000-000000000017', question: 'Explain deployment identity', input_mode: 'text', context: { schema_version: 2, anchor: { kind: target.kind, page_id: id, label: id, url: 'https://github.com/owner/repo/pull/17', observed_at: at }, target, view: { scene: 'releases' }, return_to: { section: 'releases', target } }, created_at: at, updated_at: at, status: 'answered', reply: { summary: 'Deployment answer', detail: 'Captured deployment evidence', references: [], suggested_actions: [] }, error: null, read_at: null, dismissed_at: null }] } }))
    await page.route('**/api/ask/requests/*/read', route => route.fulfill({ json: { ok: true, data: {} } }))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${base}/?view=pulls`)
    await page.getByRole('button', { name: /New answer.*Explain deployment identity/ }).click()
    await expect(page).toHaveURL(/view=releases/)
    await expect(page.getByRole('dialog')).toContainText('Deployment answer')
    await page.getByRole('button', { name: 'Back to task' }).click()
    if (mode === 'removed-target' || mode === 'wrong-component') {
      await expect(page.getByText(mode === 'removed-target' ? /original deployment target is missing/ : /original receipt is missing or has been superseded/)).toBeVisible()
      await expect(page.locator('.rel-root .ask-origin')).toHaveCount(0)
    } else {
      await expect(page.getByText(mode === 'changed-head' ? /PR head changed since this question/ : /Showing originating release/)).toBeVisible()
      const origin = page.locator('.rel-root .ask-origin')
      await expect(origin).toHaveCount(1)
      if (mode !== 'changed-head') await expect(origin).toHaveAttribute('data-origin-pull', id)
    }
    await page.screenshot({ path: testInfo.outputPath(`${mode}.png`), fullPage: true })
  })
}

test('real Ask HTTP service persists independent typed questions and enforces source and owner boundaries', async ({ page, request }, testInfo) => {
  const root = mkdtempSync(resolve('.ask-live-')), scene = { ...fixtureScene(), searchIndex: { documents: [], notes: [] } }
  const token = 'disposable-bridge-token-0000000000000000'
  const createApi = () => new AskApi({ scene: async () => scene }, root, async () => ({ ownerLogins: ['owner@example.test', 'other@example.test'], bridgeToken: token }), { pulls: async () => ({ pulls: [], repositories: [], warnings: [], associationsComplete: true }), releases: async () => ({ pulls: [], unassociatedCards: [], warnings: [], associationsComplete: true, associationsWritable: false, generatedAt: scene.generatedAt }) })
  liveAsk = createApi()
  seedOriginAllowlist(Number(new URL(base).port))
  const headers = { 'Tailscale-User-Login': 'owner@example.test', 'X-Tinstar-UI': '1' }
  const transcript: unknown[] = []
  const call = async (path: string, data?: unknown, auth: Record<string, string> = headers) => {
    const response = data === undefined ? await request.get(base + '/api/ask/' + path, { headers: auth }) : await request.post(base + '/api/ask/' + path, { headers: auth, data })
    const body = await response.json(); transcript.push({ path, status: response.status(), body }); return { status: response.status(), body }
  }
  try {
    const body = { client_key: crypto.randomUUID(), card_id: fixtureId(1), question: 'Live persistent work question', view: { scene: 'overview' } }
    const first = await call('requests', body)
    expect(first.status).toBe(200)
    const second = await call('requests', { client_key: crypto.randomUUID(), target: { kind: 'claim', id: scene.claims.find(claim => claim.verification === 'confirmed' && scene.cards.some(card => card.id === claim.cardId))!.id }, question: 'Live verified relationship question', view: { scene: 'overview' } })
    expect(second.status).toBe(200)
    expect(second.body.data.context.anchor.kind).toBe('link')
    expect((await call('requests', body)).body.data.request_id).toBe(first.body.data.request_id)
    expect((await call('requests', undefined, { ...headers, 'Tailscale-User-Login': 'other@example.test' })).body.data).toEqual([])
    expect((await call('requests', undefined, {})).status).toBe(403)
    expect((await call('requests', { client_key: crypto.randomUUID(), target: { kind: 'pull', id: 'unauthorized/repo#1' }, question: 'Unavailable source', view: { scene: 'pulls' } })).status).toBe(404)
    await page.setExtraHTTPHeaders(headers)
    await page.route('**/api/ask/**', route => route.continue())
    await page.goto(base)
    await expect(page.getByText(body.question, { exact: true })).toBeVisible()
    await page.getByRole('navigation').getByRole('button', { name: /^Releases/ }).click()
    liveAsk = createApi()
    await page.reload()
    await expect(page.getByText('Live verified relationship question', { exact: true })).toBeVisible()
    for (const [index, row] of [first.body.data, second.body.data].entries()) {
      const bridgeHeaders = { Authorization: `Bearer ${token}` }
      expect((await call('bridge', { request_id: row.request_id, note: { schema: 'fm-inbox-note.v1', outcome: 'created', id: `note-${index}`, request_id: `tinstar-ask-${row.request_id}`, saved: true, announced: true, acknowledged: false } }, bridgeHeaders)).status).toBe(200)
      expect((await call('bridge', { request_id: row.request_id, reply: { id: `note-${index}`, at: new Date().toISOString(), body: `Disposable bridge answer ${index}`, cursor: '1' } }, bridgeHeaders)).status).toBe(200)
    }
    await expect(page.getByText('Disposable bridge answer 0', { exact: true })).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Disposable bridge answer 1', { exact: true })).toBeVisible()
    expect((await call('requests')).body.data).toHaveLength(2)
    await page.screenshot({ path: testInfo.outputPath('independent-answers.png'), fullPage: true })
    await testInfo.attach('Live HTTP transcript', { body: JSON.stringify(transcript, null, 2), contentType: 'application/json' })
  } finally { liveAsk = undefined; rmSync(root, { recursive: true, force: true }) }
})

for (const width of [1440, 390]) {
  test(`closed PR Ask return preserves filters and expands its changed head at ${width}px`, async ({ page }, testInfo) => {
    const head = 'b'.repeat(40), at = new Date().toISOString(), id = 'owner/repo#17'
    const target = { kind: 'pull', id, head: 'a'.repeat(40) }, view = { scene: 'pulls', query: 'deliberately hides this origin', sort: 'author', descending: true }
    const pull = { id, repository: 'owner/repo', number: 17, url: 'https://github.com/owner/repo/pull/17', state: 'merged', title: 'Closed origin fixture', author: 'owner', draft: false, head, base: 'main', createdAt: at, updatedAt: at, observedAt: at, freshness: 'fresh', links: [] }
    await page.route('**/api/pulls**', async route => {
      const path = new URL(route.request().url()).pathname
      const data = path.endsWith('/origin') ? pull : path.endsWith('/detail') ? { head, state: 'closed', body: 'Closed PR authoritative description', bodyTruncated: false, additions: 2, deletions: 1, files: 0, checks: 'passed', review: 'Approved review', reviews: [], reviewsComplete: true, freshness: 'fresh', observedAt: at, error: null }
        : path.endsWith('/files') ? { head, baseHead: head, files: [], expectedFiles: 0, complete: true, freshness: 'fresh', observedAt: at, error: null }
          : { pulls: [], repositories: [], warnings: [], associationsComplete: true }
      await route.fulfill({ json: { ok: true, data } })
    })
    await page.route('**/api/ask/requests', route => route.fulfill({ json: { ok: true, data: [{ request_id: '20000000-0000-4000-8000-000000000017', conversation_id: '20000000-0000-4000-8000-000000000017', question: 'Explain closed PR evidence', input_mode: 'text', context: { schema_version: 2, anchor: { kind: 'pull', page_id: id, label: id, url: pull.url, observed_at: at }, target, view, return_to: { section: 'pulls', target, view } }, created_at: at, updated_at: at, status: 'answered', reply: { summary: 'Closed origin answer', detail: 'Retained evidence for this PR', references: [], suggested_actions: [] }, error: null, read_at: null, dismissed_at: null }] } }))
    await page.route('**/api/ask/requests/*/read', route => route.fulfill({ json: { ok: true, data: {} } }))
    await page.setViewportSize({ width, height: 900 })
    await page.goto(`${base}/?view=releases`)
    if (width === 390) await page.getByRole('button', { name: /Open Your desk/ }).click()
    await page.getByRole('button', { name: /New answer.*Explain closed PR evidence/ }).click()
    await expect(page.locator('.pr-row.ask-origin')).toHaveAttribute('data-ask-origin', id)
    await expect(page.getByText('Closed PR authoritative description')).toBeVisible()
    await expect(page.getByText(/Showing originating PR.*merged/)).toContainText('head changed')
    await expect(page.getByRole('textbox', { name: 'Find PRs' })).toHaveValue(view.query)
    await expect(page.getByRole('dialog')).toContainText('Closed origin answer')
    await page.getByRole('button', { name: 'Back to task' }).click()
    await expect(page.locator('.pr-row.ask-origin')).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`closed-return-${width}.png`), fullPage: true })
    await page.getByRole('button', { name: 'Show all PRs in this view' }).click()
    await expect(page.getByRole('textbox', { name: 'Find PRs' })).toHaveValue(view.query)
    await expect(page.locator('.pr-row')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Author ↓' })).toBeVisible()
  })
}

import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { AskApi } from '../src/server/ask/routes'
import { askItemSchema } from '../src/shared/ask'
import { seedOriginAllowlist } from '../src/server/api/originAllowlist'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { decideStaticServe } from '../src/server/staticServe'
import { fixtureId, fixtureQueue, fixtureScene } from '../test-fixtures/reconciliation/scenes'
import { objectFixture } from '../test-fixtures/releases/objects'
import type { ReleasePull } from '../src/shared/releases'
import type { ReleaseTarget } from '../src/shared/releaseObjects'

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
          : path === '/api/reconciliation/queue' ? fixtureQueue()
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
  const desk = page.getByRole('complementary', { name: 'Discuss' }), separator = page.getByRole('separator', { name: 'Resize Discuss' })
  await desk.getByRole('navigation', { name: 'Discuss views' }).getByRole('button', { name: /^Waiting/ }).click()
  await expect(desk.getByText('Independent question 0')).toBeVisible()
  await desk.evaluate(element => { (element as HTMLElement).dataset.mountWitness = 'same-desk' })
  const divider = (await separator.boundingBox())!
  await page.mouse.move(divider.x + 3, divider.y + 150); await page.mouse.down()
  await page.mouse.move(divider.x - 117, divider.y + 150); await page.mouse.up()
  await expect(separator).toHaveAttribute('aria-valuenow', '440')
  const nav = page.getByRole('navigation', { name: 'Activity' })
  for (const section of ['Decisions', 'PRs', 'Releases', 'Overview']) {
    await nav.getByRole('button', { name: section === 'Releases' ? /^Releases/ : section, exact: section !== 'Releases' }).click()
    await expect(desk).toHaveAttribute('data-mount-witness', 'same-desk')
    await expect(separator).toHaveAttribute('aria-valuenow', '440')
    await expect(desk.getByText('Independent question 1')).toBeVisible()
  }
  await separator.focus(); await page.keyboard.press('ArrowLeft')
  await expect(separator).toHaveAttribute('aria-valuenow', '456')
  await desk.getByRole('button', { name: 'Collapse Discuss' }).click()
  await expect(desk).toBeHidden()
  await expect(page.getByRole('button', { name: /Open Discuss/ })).toBeFocused()
  await page.reload()
  await expect(page.getByRole('complementary', { name: 'Discuss' })).toBeHidden()
  await page.getByRole('button', { name: /Open Discuss/ }).click()
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
  const trigger = page.getByRole('button', { name: /Open Discuss/ })
  await expect(trigger).toHaveCount(1)
  await trigger.click()
  const sheet = page.getByRole('dialog', { name: 'Discuss' })
  await sheet.evaluate(element => { (element as HTMLElement).dataset.mountWitness = 'mobile-desk' })
  await expect(sheet.getByRole('button', { name: 'Close Discuss' })).toBeFocused()
  await sheet.getByRole('navigation', { name: 'Discuss views' }).getByRole('button', { name: /^Waiting/ }).click()
  await expect(sheet.getByText('Independent question 0')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(sheet).toBeHidden(); await expect(trigger).toBeFocused()
  await page.getByRole('navigation').getByRole('button', { name: /^Releases/ }).click()
  await trigger.click()
  await expect(sheet).toHaveAttribute('data-mount-witness', 'mobile-desk')
  await expect(sheet.getByText('Independent question 1')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('mobile.png'), fullPage: true })
  await expect(sheet.getByRole('button', { name: 'Find worker' })).toHaveCount(0)
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
  await expect(page.getByRole('textbox', { name: 'Question', exact: true })).toHaveValue('What is happening with CI for this PR?')
  expect(requests).toHaveLength(0)
  await page.getByRole('textbox', { name: 'Question', exact: true }).fill('Isolated fixture CI question')
  await page.getByRole('button', { name: 'Send question' }).click()
  await expect(page.getByRole('region', { name: /Answer thread/ })).toContainText('Isolated fixture CI question')
  expect(requests[0]).toMatchObject({ target: { kind: 'pull', id: pull.id, head }, field_key: 'ci', view: { scene: 'pulls' } })
  expect(requests[0]).not.toHaveProperty('card_id')
  await page.getByRole('navigation').getByRole('button', { name: /^Releases/ }).click()
  records = records.map(row => ({ ...row, status: 'answered', reply: { summary: 'Isolated correlated answer', detail: 'Fixture evidence detail', references: [], suggested_actions: [] } }))
  await expect(page.getByRole('region', { name: /Answer thread/ })).toContainText('Isolated correlated answer', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Read new answer' }).click()
  await expect(page.locator('.pr-row')).toHaveCount(1)
  await expect(page.locator('.pr-row.ask-origin')).toHaveAttribute('data-ask-origin', pull.id)
  await expect(page.getByRole('region', { name: /Answer thread/ })).toContainText('Isolated correlated answer')
  await page.getByRole('button', { name: 'Collapse answer' }).click()
  await page.goBack()
  await expect(page).toHaveURL(/view=releases/)
})

for (const mode of ['release', 'receipt', 'removed-target', 'wrong-component', 'changed-head'] as const) {
  test(`release origin resolves exact identity: ${mode}`, async ({ page }, testInfo) => {
    const at = new Date().toISOString(), id = 'owner/repo#17'
    const receipt = { id: 'receipt-1', repository: 'owner/repo', environment: 'production', component: 'web', target: 'production', version: 'v17', deployedSha: 'a'.repeat(40), artifactDigest: null, deployedAt: at, receiptUrl: 'https://example.test/receipt', workflowUrl: 'https://example.test/workflow', outcome: 'succeeded' as const, exceptions: [] }
    const targets: ReleaseTarget[] = [{ component: 'web', target: 'production', readiness: 'Ready', readinessEvidence: [], receipt }, { component: 'api', target: 'production', readiness: 'Ready', readinessEvidence: [], receipt: mode === 'wrong-component' ? { ...receipt, component: 'api' } : null }]
    if (mode === 'removed-target' || mode === 'wrong-component') targets.shift()
    const target = mode === 'changed-head' ? { kind: 'pull', id, head: 'a'.repeat(40) } : { kind: mode === 'receipt' || mode === 'wrong-component' ? 'receipt' : 'release', id, component: 'web', target: 'production', ...(mode === 'receipt' || mode === 'wrong-component' ? { receipt_id: 'receipt-1' } : {}) }
    const pull: ReleasePull = { id, repository: 'owner/repo', number: 17, url: 'https://github.com/owner/repo/pull/17', title: 'Release identity proof', head: 'b'.repeat(40), links: [], exceptions: [], state: 'merged', mergedAt: at, mergeSha: 'b'.repeat(40), observedAt: at, freshness: 'fresh', deployment: { state: 'in-queue', targets: targets.map(item => ({ ...item, state: 'unknown', reason: 'Pending', ancestry: 'unknown' })) } }
    const release = { ...objectFixture('production', 'origin-release'), version: 'v17', pulls: [pull], targets }
    // Same version/PR in a different release must never substitute for the captured identity.
    const decoy = { ...release, id: 'other-release' }
    await page.route('**/api/releases', route => route.fulfill({ json: { ok: true, data: { releases: [decoy, release], pulls: [pull], unassociatedCards: [], warnings: [], associationsComplete: true, associationsWritable: false } } }))
    await page.route('**/api/ask/requests', route => route.fulfill({ json: { ok: true, data: [{ request_id: '20000000-0000-4000-8000-000000000017', conversation_id: '20000000-0000-4000-8000-000000000017', question: 'Explain deployment identity', input_mode: 'text', context: { schema_version: 2, anchor: { kind: target.kind, page_id: id, label: id, url: 'https://github.com/owner/repo/pull/17', observed_at: at }, target, view: { scene: 'releases', release_id: release.id }, return_to: { section: 'releases', target, view: { scene: 'releases', release_id: release.id } } }, created_at: at, updated_at: at, status: 'answered', reply: { summary: 'Deployment answer', detail: 'Captured deployment evidence', references: [], suggested_actions: [] }, error: null, read_at: null, dismissed_at: null }] } }))
    await page.route('**/api/ask/requests/*/read', route => route.fulfill({ json: { ok: true, data: {} } }))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`${base}/?view=pulls`)
    await page.getByRole('button', { name: /New answer.*Explain deployment identity/ }).click()
    await expect(page).toHaveURL(/view=releases/)
    if (mode === 'removed-target' || mode === 'wrong-component') {
      await expect(page.getByRole('status').filter({ hasText: 'Originating PR, target or receipt is unavailable' })).toBeVisible()
      await expect(page.locator('.rel-v3 .ask-origin')).toHaveCount(0)
      await expect(page.getByRole('dialog')).toHaveCount(0)
    } else {
      const drawer = page.getByRole('dialog', { name: 'Release identity proof' })
      const origin = drawer.locator('.ask-origin')
      await expect(drawer).toBeVisible()
      await expect(origin).toHaveCount(1)
      await expect(origin).toBeFocused()
      if (mode === 'changed-head') await expect(origin).toHaveAttribute('data-ask-origin', id)
      else {
        await expect(origin).toHaveAttribute('data-receipt-id', receipt.id)
        await expect(origin).toHaveAttribute('data-component', 'web')
        await expect(origin).toHaveAttribute('data-target', 'production')
      }
      await drawer.getByRole('button', { name: 'Close details' }).click()
      await expect(page.getByRole('tab', { name: 'Verify', exact: true })).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('button', { name: /^v17 PROD/ }).nth(1)).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByRole('button', { name: /^v17 PROD/ }).nth(0)).toHaveAttribute('aria-pressed', 'false')
      if (mode === 'changed-head') await expect(page.getByText(/PR head changed since this question/)).toBeVisible()
    }
    await expect(page.getByRole('region', { name: /Answer thread/ })).toContainText('Deployment answer')
    await page.getByRole('button', { name: 'Collapse answer' }).click()
    await page.screenshot({ path: testInfo.outputPath(`${mode}.png`), fullPage: true })
  })
}

test('real Ask HTTP service persists independent typed questions and enforces source and owner boundaries', async ({ page, request }, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'tinstar-ask-live-')), scene = { ...fixtureScene(), searchIndex: { documents: [], notes: [] } }
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
    await page.getByRole('navigation', { name: 'Discuss views' }).getByRole('button', { name: /^Waiting/ }).click()
    await expect(page.getByText(body.question, { exact: true })).toBeVisible()
    await page.getByRole('navigation').getByRole('button', { name: /^Releases/ }).click()
    liveAsk = createApi()
    await page.reload()
    await page.getByRole('navigation', { name: 'Discuss views' }).getByRole('button', { name: /^Waiting/ }).click()
    await expect(page.getByText('Live verified relationship question', { exact: true })).toBeVisible()
    for (const [index, row] of [first.body.data, second.body.data].entries()) {
      const bridgeHeaders = { Authorization: `Bearer ${token}` }
      expect((await call('bridge', { request_id: row.request_id, note: { schema: 'fm-inbox-note.v1', outcome: 'created', id: `note-${index}`, request_id: `tinstar-ask-${row.request_id}`, saved: true, announced: true, acknowledged: false } }, bridgeHeaders)).status).toBe(200)
      expect((await call('bridge', { request_id: row.request_id, reply: { id: `note-${index}`, at: new Date().toISOString(), body: `Disposable bridge answer ${index}`, cursor: '1' } }, bridgeHeaders)).status).toBe(200)
    }
    await page.getByRole('button', { name: /^Needs you/ }).click()
    await expect(page.getByText('Disposable bridge answer 0', { exact: true })).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Disposable bridge answer 1', { exact: true })).toBeVisible()
    expect((await call('requests')).body.data).toHaveLength(2)
    await page.screenshot({ path: testInfo.outputPath('independent-answers.png'), fullPage: true })
    await testInfo.attach('Live HTTP transcript', { body: JSON.stringify(transcript, null, 2), contentType: 'application/json' })
  } finally { liveAsk = undefined; rmSync(root, { recursive: true, force: true, maxRetries: 3 }) }
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
    if (width === 390) await page.getByRole('button', { name: /Open Discuss/ }).click()
    await page.getByRole('button', { name: /New answer.*Explain closed PR evidence/ }).click()
    await expect(page.locator('.pr-row.ask-origin')).toHaveAttribute('data-ask-origin', id)
    await expect(page.getByText('Closed PR authoritative description')).toBeVisible()
    await expect(page.getByText(/Showing originating PR.*merged/)).toContainText('head changed')
    await expect(page.getByRole('textbox', { name: 'Find PRs' })).toHaveValue(view.query)
    await expect(page.getByRole('region', { name: 'Answer thread: Explain closed PR evidence' })).toContainText('Closed origin answer')
    await expect(page.locator('.pr-row.ask-origin')).toBeFocused()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath(`closed-return-${width}.png`), fullPage: true })
    if (width === 390) await page.getByRole('dialog', { name: 'Discuss' }).getByRole('button', { name: 'Close Discuss' }).click()
    await page.getByRole('button', { name: 'Show all PRs in this view' }).click()
    await expect(page.getByRole('textbox', { name: 'Find PRs' })).toHaveValue(view.query)
    await expect(page.locator('.pr-row')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Author ↓' })).toBeVisible()
  })
}


test('inline neighbors survive real browser Back to the selected release, tab and audience', async ({ page }, testInfo) => {
  const at = new Date().toISOString(), head = 'a'.repeat(40), scene = fixtureScene()
  const claim = scene.claims.find(link => link.verification === 'confirmed' && link.state === 'current')!
  const pulls = Array.from({ length: 80 }, (_, index) => ({ id: `owner/repo${Math.floor(index / 10)}#${index + 1}`, repository: `owner/repo${Math.floor(index / 10)}`, number: index + 1, url: `https://github.com/owner/repo${Math.floor(index / 10)}/pull/${index + 1}`, title: `Release ${index + 1}`, author: 'owner', draft: false, head, base: 'main', createdAt: at, updatedAt: at, observedAt: at, freshness: 'fresh', links: [], exceptions: [], state: 'merged', mergedAt: at, mergeSha: head, deployment: { state: 'shipped', targets: [] } }))
  const origin = pulls[24]!
  const releases = [{ ...objectFixture('production', 'first-release'), version: 'v1.0.0', pulls: pulls.slice(0, 10) }, { ...objectFixture('production', 'selected-release'), version: 'v2.0.0', pulls: pulls.slice(20, 30) }]
  let records = askItemSchema.array().parse([
    { request_id: '30000000-0000-4000-8000-000000000001', conversation_id: '40000000-0000-4000-8000-000000000001', question: 'Inline PR investigation', input_mode: 'text', context: { target: { kind: 'pull', id: origin.id, head }, anchor: { kind: 'pull', page_id: origin.id, label: origin.id, url: origin.url, observed_at: at }, view: { scene: 'pulls' }, return_to: { section: 'pulls', target: { kind: 'pull', id: origin.id, head } } }, created_at: at, updated_at: at, status: 'answered', reply: { summary: 'Independent PR answer', detail: 'Detailed PR evidence stays inline.', references: [], suggested_actions: [] }, error: null, read_at: null, dismissed_at: null },
    { request_id: '30000000-0000-4000-8000-000000000002', conversation_id: '40000000-0000-4000-8000-000000000002', question: 'Independent link investigation', input_mode: 'text', context: { target: { kind: 'claim', id: claim.id }, anchor: { kind: 'link', page_id: claim.id, label: 'Verified relationship', url: null, observed_at: at }, view: { scene: 'overview' }, return_to: { section: 'overview', target: { kind: 'claim', id: claim.id } } }, created_at: at, updated_at: at, status: 'answered', reply: { summary: 'Independent link answer', detail: 'Both verified endpoints and their exact link.', references: [], suggested_actions: [] }, error: null, read_at: null, dismissed_at: null },
  ])
  await page.route('**/api/pulls', route => route.fulfill({ json: { ok: true, data: { pulls, repositories: [], warnings: [], associationsComplete: true } } }))
  await page.route('**/api/releases', route => route.fulfill({ json: { ok: true, data: { releases, pulls, unassociatedCards: [], warnings: [], associationsComplete: true, associationsWritable: false } } }))
  await page.route('**/api/ask/requests', route => route.fulfill({ json: { ok: true, data: records } }))
  await page.route('**/api/ask/requests/*/read', route => {
    records = records.map(record => route.request().url().includes(record.request_id) ? { ...record, read_at: at } : record)
    return route.fulfill({ json: { ok: true, data: {} } })
  })
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${base}/?view=releases`)
  await page.getByRole('tab', { name: 'Verify', exact: true }).click()
  await page.getByRole('button', { name: /^v2\.0\.0 PROD/ }).click()
  await page.getByRole('tab', { name: 'Release notes', exact: true }).click()
  await page.getByRole('button', { name: 'Customer', exact: true }).click()
  await page.evaluate(() => document.fonts.ready)
  await page.getByRole('button', { name: /New answer.*Inline PR investigation/ }).click()
  await expect(page.locator('.pr-row.ask-origin')).toHaveAttribute('data-ask-origin', origin.id)
  await expect(page.getByRole('region', { name: 'Answer thread: Inline PR investigation', exact: true })).toContainText('Detailed PR evidence stays inline.')
  await expect(page.getByRole('button', { name: /New answer.*Independent link investigation/ })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.goBack()
  await expect(page.getByRole('tab', { name: 'Verify', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: /^v2\.0\.0 PROD/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('tab', { name: 'Release notes', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('button', { name: 'Customer', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('region', { name: /Answer thread/ })).toBeVisible()
  await page.getByRole('button', { name: /New answer.*Independent link investigation/ }).click()
  await expect(page.getByRole('region', { name: 'Overview', exact: true })).toBeVisible()
  await expect(page.locator('.ov-line.flashed')).toHaveCount(1)
  await expect(page.getByRole('region', { name: /Answer thread/ })).toContainText('Both verified endpoints')
  await page.screenshot({ path: testInfo.outputPath('inline-link-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: /^Open Discuss/ }).click()
  const sheet = page.getByRole('dialog', { name: 'Discuss' })
  await expect(sheet.getByRole('region', { name: /Answer thread/ })).toBeVisible()
  const bounds = await sheet.boundingBox()
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await page.screenshot({ path: testInfo.outputPath('inline-mobile.png') })
})

test('compact unread previews pulse only until opened and respect reduced motion', async ({ page }, testInfo) => {
  let records = [0,1,2].map(index => askItemSchema.parse({
    request_id: `00000000-0000-4000-8000-00000000000${index}`, conversation_id: `10000000-0000-4000-8000-00000000000${index}`,
    question: 'Can the release proceed?', input_mode: 'text', context: { anchor: { kind: 'work', page_id: fixtureId(1), label: 'Release readiness', url: null, observed_at: null }, view: { scene: 'overview' } },
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'answered', reply: { summary: 'Review passed. Ready for the next decision.', detail: 'The complete evidence remains available.', references: [], suggested_actions: [] }, error: null, read_at: null, dismissed_at: null
  }))
  await page.route('**/api/ask/requests', route => route.fulfill({ json: { ok: true, data: records } }))
  await page.route('**/api/ask/requests/*/read', route => {
    records = records.map(record => route.request().url().includes(record.request_id) ? { ...record, read_at: new Date().toISOString() } : record)
    return route.fulfill({ json: { ok: true, data: {} } })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(base)
  const cards = page.locator('.ask-desk article')
  await expect(cards).toHaveCount(3)
  const heights = await cards.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))
  for (const height of heights) expect(height).toBeLessThanOrEqual(96)
  await testInfo.attach('Collapsed card heights', { body: JSON.stringify(heights), contentType: 'application/json' })
  const accent = page.locator('.ask-desk article[data-ask-id="00000000-0000-4000-8000-000000000000"]')
  const archiveBesideTitle = async () => {
    const title = await accent.locator('.ask-preview strong').boundingBox()
    const archive = await accent.getByRole('button', { name: 'Archive conversation', exact: true }).boundingBox()
    const card = await accent.boundingBox()
    expect(archive!.x).toBeGreaterThanOrEqual(title!.x + title!.width - 1)
    expect(archive!.x + archive!.width).toBeLessThanOrEqual(card!.x + card!.width + 1)
  }
  await archiveBesideTitle()
  await expect(accent).toHaveAttribute('data-unread', 'true')
  expect(await accent.evaluate(node => getComputedStyle(node, '::before').animationDuration)).toBe('2.5s')
  await page.screenshot({ path: testInfo.outputPath('compact-desktop.png') })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await accent.evaluate(node => getComputedStyle(node, '::before').animationName)).toBe('none')
  await page.setViewportSize({ width: 390, height: 844 })
  const open = page.getByRole('button', { name: /Open Discuss/ })
  await expect(open).toBeVisible()
  await open.click()
  await expect(accent.getByRole('button', { name: 'Archive conversation', exact: true })).toBeVisible()
  await archiveBesideTitle()
  await page.screenshot({ path: testInfo.outputPath('compact-mobile-reduced-motion.png') })
  await accent.locator('.ask-preview').click()
  await expect(page.getByText('The complete evidence remains available.')).toBeVisible()
  await expect(accent).toHaveAttribute('data-unread', 'false')
  const reply = page.getByRole('textbox', { name: 'Reply to First Mate' })
  await reply.focus()
  await page.setViewportSize({ width: 390, height: 480 })
  expect((await reply.boundingBox())!.y + (await reply.boundingBox())!.height).toBeLessThanOrEqual(480)
  await expect(page.getByRole('button', { name: 'Send reply' })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Collapse answer' }).click()
  await archiveBesideTitle()
})

test('live Desk archive survives polling, immediate Undo, unseen follow-up, restart and a later unread answer', async ({ page, request, browser }, testInfo) => {
  page.setDefaultTimeout(8000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-ask-live-'))
  const scene = { ...fixtureScene(), searchIndex: { documents: [], notes: [] } }, token = 'disposable-bridge-token-0000000000000000'
  const createApi = () => new AskApi({ scene: async () => scene }, root, async () => ({ ownerLogins: ['owner@example.test'], bridgeToken: token }))
  liveAsk = createApi(); seedOriginAllowlist(Number(new URL(base).port))
  const headers = { 'Tailscale-User-Login': 'owner@example.test', 'X-Tinstar-UI': '1' }
  const transcript: unknown[] = []
  const call = async (path: string, data?: unknown, auth: Record<string, string> = headers) => {
    const response = data === undefined ? await request.get(base + '/api/ask/' + path, { headers: auth }) : await request.post(base + '/api/ask/' + path, { headers: auth, data })
    const body = await response.json(); transcript.push({ path, status: response.status(), body }); expect(response.ok()).toBe(true); return body.data
  }
  const create = (question: string, follow_up_to?: string) => call('requests', { client_key: crypto.randomUUID(), card_id: fixtureId(1), question, view: { scene: 'overview' }, ...(follow_up_to ? { follow_up_to } : {}) })
  const bridge = async (id: string, summary: string) => {
    const auth = { Authorization: `Bearer ${token}` }
    await call('bridge', { request_id: id, note: { schema: 'fm-inbox-note.v1', outcome: 'created', id: `note-${id}`, request_id: `tinstar-ask-${id}`, saved: true, announced: true, acknowledged: false } }, auth)
    await call('bridge', { request_id: id, reply: { id: `note-${id}`, at: new Date().toISOString(), body: summary, cursor: '1' } }, auth)
  }
  try {
    const first = await create('Live archive conversation')
    await bridge(first.request_id, 'Available first answer')
    await page.setExtraHTTPHeaders(headers)
    await page.route('**/api/ask/**', route => route.continue())
    await page.goto(base)
    const card = page.locator('.ask-desk article')
    await expect(card).toHaveAttribute('data-unread', 'true')
    expect((await call('requests'))[0].read_at).toBeNull()
    const follow = await create('Follow-up from another device', first.request_id)
    // Delay the actual server mutation beyond the five-second polling interval.
    await page.route('**/api/ask/requests/*/dismiss', async route => { await new Promise(resolve => setTimeout(resolve, 6200)); await route.continue() })
    await card.getByRole('button', { name: 'Archive conversation', exact: true }).click()
    await expect(card).toHaveCount(0)
    await page.waitForTimeout(5400)
    await expect(card).toHaveCount(0)
    await page.getByRole('button', { name: 'Undo archive' }).click()
    await expect(card).toHaveCount(1)
    await page.waitForTimeout(1800)
    expect((await call('requests')).every((row: { dismissed_at: string | null }) => row.dismissed_at === null)).toBe(true)
    await page.unroute('**/api/ask/requests/*/dismiss')
    await card.getByRole('button', { name: 'Archive conversation', exact: true }).click()
    await page.getByRole('button', { name: /^History/ }).click()
    await page.getByRole('searchbox', { name: 'Search question history' }).fill('Available first answer')
    await expect(card).toHaveCount(1)
    await expect(card).toHaveAttribute('data-unread', 'false')
    expect((await call('requests')).every((row: { dismissed_at: string | null }) => !!row.dismissed_at)).toBe(true)
    liveAsk = createApi(); await page.reload()
    await page.getByRole('button', { name: /^History/ }).click()
    await expect(card).toHaveCount(1)
    await card.getByRole('button', { name: 'Restore to inbox' }).click()
    await page.getByRole('button', { name: /^Needs you/ }).click()
    await expect(card).toContainText('Available first answer')
    await card.locator('.ask-preview').click()
    await expect(page.getByRole('region', { name: /Answer thread/ })).toContainText('Follow-up from another device')
    await expect.poll(async () => (await call('requests'))[0].read_at).toBeTruthy()
    await page.getByRole('button', { name: 'Collapse answer' }).click()
    await card.getByRole('button', { name: 'Archive conversation', exact: true }).click()
    await expect.poll(async () => (await call('requests')).every((row: { dismissed_at: string | null }) => !!row.dismissed_at)).toBe(true)
    await bridge(follow.request_id, 'Genuine later answer resurfaces')
    await page.getByRole('button', { name: /^Needs you/ }).click()
    await expect(card).toContainText('Genuine later answer resurfaces', { timeout: 10000 })
    await expect(card).toHaveAttribute('data-unread', 'true')
    await page.screenshot({ path: testInfo.outputPath('resurfaced-answer.png') })
    await card.locator('.ask-preview').click()
    await expect(card).toHaveAttribute('data-unread', 'false')
    await expect.poll(async () => (await call('requests')).find((row: { request_id: string }) => row.request_id === follow.request_id).read_at).toBeTruthy()
    const other = await browser.newPage({ extraHTTPHeaders: headers })
    other.setDefaultTimeout(8000)
    other.on('pageerror', error => transcript.push({ secondDeviceError: error.message }))
    await other.route('**/api/**', async route => {
      if (new URL(route.request().url()).pathname.startsWith('/api/ask/')) return route.continue()
      const path = new URL(route.request().url()).pathname
      const data = path === '/api/fleet' ? { ready: true, workers: [], attention: [], errors: [] } : path === '/api/fleet/messages' ? [] : path === '/api/reconciliation/scene' ? scene : path === '/api/reconciliation/queue' ? { items: [] } : path === '/api/releases' ? { pulls: [], unassociatedCards: [], warnings: [], associationsComplete: true, associationsWritable: false } : path === '/api/pulls' ? { pulls: [], repositories: [], warnings: [], associationsComplete: true } : path === '/api/quota' ? { providers: [], checkedAt: null, fetchedAt: null, commandError: null } : {}
      await route.fulfill({ json: path === '/api/quota' ? data : { ok: true, data } })
    })
    await other.goto(base)
    const otherTrigger = other.getByRole('button', { name: /Open Discuss/ })
    if (await otherTrigger.isVisible()) await otherTrigger.click()
    await other.getByRole('button', { name: /^Needs you/ }).click()
    await expect(other.locator('.ask-desk article')).toHaveAttribute('data-unread', 'false')
    await other.screenshot({ path: testInfo.outputPath('second-device.png') })
    await other.close()
    await page.getByRole('textbox', { name: 'Reply to First Mate', exact: true }).fill('Live inline follow-up')
    await page.getByRole('button', { name: 'Send reply', exact: true }).click()
    await expect.poll(async () => (await call('requests')).length).toBe(3)
    expect((await call('requests')).every((row: { conversation_id: string }) => row.conversation_id === first.conversation_id)).toBe(true)
    writeFileSync(testInfo.outputPath('archive-read-http.json'), JSON.stringify(transcript, null, 2))
    await testInfo.attach('Archive and read HTTP transcript', { path: testInfo.outputPath('archive-read-http.json'), contentType: 'application/json' })
  } finally { liveAsk = undefined; rmSync(root, { recursive: true, force: true, maxRetries: 3 }) }
})

test('retained worker note exposes targeted retry and reply after its worker leaves the fleet', async ({ page }, testInfo) => {
  let note = { requestId: 'tinstar-retained-live', home: '/disposable/firstmate', taskId: 'departed-worker', decisionKey: null, kind: 'message', text: 'Retained worker investigation', state: 'saved', announced: false, reply: null as string | null, canReceive: false }
  const submissions: unknown[] = []
  await page.route('**/api/fleet/messages', async route => {
    if (route.request().method() === 'POST') { submissions.push(route.request().postDataJSON()); note = { ...note, announced: true, reply: 'Retained response from First Mate' }; await route.fulfill({ json: { ok: true, data: { saved: true, error: null, canReceive: false } } }) }
    else await route.fulfill({ json: { ok: true, data: [note] } })
  })
  await page.goto(base)
  await page.getByRole('navigation', { name: 'Activity' }).getByRole('button', { name: 'Decisions', exact: true }).click()
  await page.getByText('Some sources need verification', { exact: true }).click()
  await page.getByText('Technical diagnostics', { exact: true }).click()
  await page.getByText('Retained worker notes', { exact: true }).click()
  const retained = page.locator('.cockpit-messages')
  await expect(retained).toContainText('Delivery failed')
  await retained.getByText('Delivery details').click()
  await retained.getByRole('button', { name: 'Retry delivery' }).click()
  expect(submissions).toEqual([{ requestId: note.requestId, kind: 'message', text: note.text }])
  await expect(retained).toContainText('Retained response from First Mate')
  await expect(retained.getByRole('button', { name: 'Retry delivery' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Message receipts' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('retained-worker-note.png') })
})

test('formal decisions remain in Decisions and never enter conversation tab counts', async ({ page }, testInfo) => {
  let queue = fixtureQueue()
  await page.route('**/api/reconciliation/queue', route => route.fulfill({ json: { ok: true, data: queue } }))
  await page.goto(base)
  const tabs = page.getByRole('navigation', { name: 'Discuss views' })
  await expect(tabs.getByRole('button', { name: 'Needs you 0', exact: true })).toBeVisible()
  await expect(tabs.getByRole('button', { name: 'Waiting 2', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.global-desk .ov-queue')).toHaveCount(0)
  await expect(page.locator('.ask-desk article')).toHaveCount(2)
  await page.getByRole('navigation', { name: 'Activity' }).getByRole('button', { name: 'Decisions', exact: true }).click()
  await expect(page.locator('.decisions-row')).not.toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('separate-decisions.png') })
  queue = { ...queue, items: queue.items.map(item => ({ ...item, sources: item.sources.map(source => ({ ...source, expiresAt: '2020-01-01T00:00:00Z' })) })) }
  await page.reload()
  await page.locator('.decisions-row').first().click()
  await expect(page.getByLabel('Selected decision')).toContainText('needs verification')
  await expect(page.getByRole('textbox', { name: 'Answer this decision' })).toHaveCount(0)
})

test('delivered questions offer waiting copy while genuine failures alone expose retry', async ({ page }, testInfo) => {
  const records = ['delivered', 'failed'].map((status, index) => askItemSchema.parse({ request_id: `00000000-0000-4000-8000-00000000000${index}`, conversation_id: `10000000-0000-4000-8000-00000000000${index}`, question: `${status} delivery check`, input_mode: 'text', context: { anchor: { kind: 'work', page_id: fixtureId(1), label: 'Delivery check', url: null, observed_at: null }, view: { scene: 'overview' } }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status, reply: null, error: status === 'failed' ? 'Disposable save failure' : null, read_at: null, dismissed_at: null }))
  const retries: string[] = []
  await page.route('**/api/ask/requests', route => route.fulfill({ json: { ok: true, data: records } }))
  await page.route('**/api/ask/requests/*/retry', route => { retries.push(route.request().url()); return route.fulfill({ json: { ok: true, data: records[1] } }) })
  await page.goto(base)
  await page.locator('.ask-preview').click()
  await expect(page.getByRole('button', { name: 'Retry delivery: failed delivery check', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Retry delivery: failed delivery check', exact: true }).click()
  expect(retries).toHaveLength(1)
  await page.getByRole('button', { name: 'Collapse answer' }).click()
  await page.getByRole('navigation', { name: 'Discuss views' }).getByRole('button', { name: /^Waiting/ }).click()
  await expect(page.locator('.ask-preview')).toContainText('Waiting for answer')
  await page.locator('.ask-preview').click()
  await expect(page.getByRole('button', { name: /Retry delivery/ })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('delivered-waiting.png') })
})

test('answer arriving while an expanded waiting thread is collapsed stays unread until intentionally opened', async ({ page }, testInfo) => {
  let record = askItemSchema.parse({ request_id: '00000000-0000-4000-8000-000000000001', conversation_id: '10000000-0000-4000-8000-000000000001', question: 'Waiting while Desk is closed', input_mode: 'text', context: { anchor: { kind: 'work', page_id: fixtureId(1), label: 'Delayed answer', url: null, observed_at: null }, view: { scene: 'overview' } }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'sent', reply: null, error: null, read_at: null, dismissed_at: null })
  let reads = 0
  await page.route('**/api/ask/requests', route => route.fulfill({ json: { ok: true, data: [record] } }))
  await page.route('**/api/ask/requests/*/read', route => { reads++; record = { ...record, read_at: new Date().toISOString() }; return route.fulfill({ json: { ok: true, data: record } }) })
  await page.goto(base)
  await page.getByRole('navigation', { name: 'Discuss views' }).getByRole('button', { name: /^Waiting/ }).click()
  await page.locator('.ask-preview').click()
  await page.getByRole('button', { name: 'Collapse Discuss' }).click()
  record = { ...record, status: 'answered', reply: { summary: 'Answer arrived while closed', detail: 'New evidence', references: [], suggested_actions: [] } }
  await page.waitForTimeout(5500)
  await page.getByRole('button', { name: /Open Discuss/ }).click()
  await expect(page.locator('.ask-desk article')).toHaveAttribute('data-unread', 'true')
  expect(reads).toBe(0)
  await page.screenshot({ path: testInfo.outputPath('unopened-arrival.png') })
  await page.getByRole('button', { name: 'Read new answer' }).click()
  await expect(page.locator('.ask-desk article')).toHaveAttribute('data-unread', 'false')
  expect(reads).toBe(1)
})

test('live Desk quietly drops invalid recommendations and returns sender receipts', async ({ page, request }, testInfo) => {
  const root = mkdtempSync(join(tmpdir(), 'tinstar-ask-live-'))
  const scene = { ...fixtureScene(), searchIndex: { documents: [], notes: [] } }
  const token = 'disposable-rejection-token-000000000000'
  const createApi = () => new AskApi({ scene: async () => scene }, root, async () => ({ ownerLogins: ['owner@example.test'], bridgeToken: token }))
  liveAsk = createApi(); seedOriginAllowlist(Number(new URL(base).port))
  const headers = { 'Tailscale-User-Login': 'owner@example.test', 'X-Tinstar-UI': '1' }
  const transcript: unknown[] = []
  const call = async (path: string, data?: unknown, auth: Record<string, string> = headers) => {
    const response = data === undefined ? await request.get(base + '/api/ask/' + path, { headers: auth }) : await request.post(base + '/api/ask/' + path, { headers: auth, data })
    const body = await response.json()
    transcript.push({ path, status: response.status(), body })
    expect(response.ok()).toBe(true)
    return body.data
  }
  const sender = { Authorization: `Bearer ${token}` }
  const valid = { id: 'keep-open', label: 'Keep open', instruction: 'Retain the card until the review lands' }
  const invalid = { id: 'merge-3359', label: 'Merge now', instruction: 'Open https://example.test/pull/3359' }
  try {
    await page.setViewportSize({ width: 1440, height: 1400 })
    await page.setExtraHTTPHeaders(headers)
    await page.route('**/api/ask/**', route => route.continue())
    for (const [kind, actions] of [
      ['mixed', [invalid, { ...invalid, id: 'merge-3360' }, valid]],
      ['all-invalid', [invalid]],
      ['duplicate', [valid, valid]],
      ['oversized', Array.from({ length: 11 }, (_, i) => ({ ...valid, id: `choice-${i}` }))],
    ] as const) {
      const first = await call('requests', { client_key: crypto.randomUUID(), card_id: fixtureId(1), question: `Review recommendations: ${kind}`, view: { scene: 'overview' } })
      await call('bridge', { request_id: first.request_id, note: { schema: 'fm-inbox-note.v1', outcome: 'created', id: `note-${kind}`, request_id: `tinstar-ask-${first.request_id}`, saved: true, announced: true, acknowledged: false } }, sender)
      const update = { request_id: first.request_id, reply: { id: `note-${kind}`, at: new Date().toISOString(), cursor: '1', body: JSON.stringify({ schema: 'tinstar.ask-reply.v1', request_id: first.request_id, summary: `Review can proceed: ${kind}`, detail: 'The evidence is retained and the review remains available.', references: [], suggested_actions: actions }) } }
      const receipt = await call('bridge', update, sender)
      liveAsk = createApi()
      await page.goto(base)
      await page.getByRole('button', { name: new RegExp(`New answer.*Review recommendations: ${kind}`) }).click()
      const thread = page.getByRole('region', { name: `Answer thread: Review recommendations: ${kind}`, exact: true })
      await expect(thread).toContainText('The evidence is retained and the review remains available.')
      const screenshot = process.env.REJECTION_EVIDENCE_DIR ? resolve(process.env.REJECTION_EVIDENCE_DIR, `${process.env.REJECTION_CAPTURE_PREFIX ?? 'after'}-${kind}.png`) : testInfo.outputPath(`${kind}.png`)
      await page.screenshot({ path: screenshot, fullPage: true })
      await expect(page.locator('body')).not.toContainText('suggested actions were rejected')
      await expect(thread.getByText(/URLs and link syntax/)).toBeHidden()
      expect(receipt.reply_warnings).toHaveLength(kind === 'mixed' ? 2 : actions.length)
      expect((await call('bridge', update, sender)).reply_warnings).toEqual(receipt.reply_warnings)
      const saved = (await call('requests')).find((row: { request_id: string }) => row.request_id === first.request_id)
      expect(saved.reply.suggested_actions).toEqual(kind === 'mixed' ? [valid] : [])
      if (kind === 'mixed') {
        // Drain a persisted reply journal through the real installed adapter,
        // using an isolated executable inbox as the external First Mate sink.
        const home = resolve(root, 'firstmate'), journal = resolve(home, 'state/tinstar-ask-reply-receipts')
        mkdirSync(journal, { recursive: true }); mkdirSync(resolve(home, 'bin'))
        writeFileSync(resolve(journal, 'reply.json'), JSON.stringify({ origin: base, payload: update }))
        writeFileSync(resolve(home, 'bin/fm-inbox.sh'), `#!/usr/bin/env python3
import json,os,pathlib,sys
home=pathlib.Path(os.environ['FM_HOME'])
if sys.argv[1]=='receipts':
 print(json.dumps({'schema':'fm-inbox-receipts.v1','pending':[],'handled':[],'omitted':[]}))
else:
 assert sys.argv[1:3]==['note','--request-id']
 (home/'warning-note.txt').write_text(sys.stdin.read())
 print(json.dumps({'saved':True,'request_id':sys.argv[3],'id':'warning-note'}))
`, { mode: 0o700 })
        await new Promise<void>((resolveRun, reject) => execFile('python3', ['-B', '-c', "import runpy,sys,pathlib; p=runpy.run_path('scripts/ask-puller.py'); print(p['pull_once'](sys.argv[1],sys.argv[2],pathlib.Path(sys.argv[3])))", base, token, home], { cwd: resolve('.') }, error => error ? reject(error) : resolveRun()))
        const warningNote = readFileSync(resolve(home, 'warning-note.txt'), 'utf8')
        const warningPayload = warningNote.split('\n')[1]
        if (warningPayload === undefined) throw new Error('Missing warning note payload')
        expect(JSON.parse(warningPayload).reply_warnings).toEqual(receipt.reply_warnings)
        expect(existsSync(resolve(journal, 'reply.json'))).toBe(false)
        transcript.push({ firstmateInboxNote: warningNote })
        if (process.env.REJECTION_EVIDENCE_DIR) writeFileSync(resolve(process.env.REJECTION_EVIDENCE_DIR, 'firstmate-warning-note.txt'), warningNote)
        await thread.getByRole('button', { name: 'Keep open: Retain the card until the review lands' }).click()
        const pending = (await call('bridge', undefined, sender)).pending
        const selected = pending.find((row: { body: string }) => {
          const payload = row.body.split('\n')[1]
          if (payload === undefined) throw new Error('Missing pending action payload')
          return JSON.parse(payload).action_selection?.action_id === valid.id
        })
        expect(selected).toBeTruthy()
        const envelope = JSON.parse(selected.body.split('\n')[1])
        expect(envelope.question).toBe(valid.instruction)
        expect(envelope.conversation.turns[1].reply.rejected_actions).toEqual(receipt.reply_warnings)
        const rejected = await request.post(base + '/api/ask/selections', { headers, data: { answer_id: first.request_id, action_id: invalid.id, client_key: crypto.randomUUID() } })
        expect(rejected.ok()).toBe(false)
        transcript.push({ rejectedSelectionStatus: rejected.status() })
      }
    }
  } finally {
    if (process.env.REJECTION_EVIDENCE_DIR) writeFileSync(resolve(process.env.REJECTION_EVIDENCE_DIR, `${process.env.REJECTION_CAPTURE_PREFIX ?? 'after'}-http.json`), JSON.stringify(transcript, null, 2))
    liveAsk = undefined; rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
})


test('a new reply anchors only when the reader is already at the latest exchange', async ({ page }) => {
  const conversationId = '10000000-0000-4000-8000-000000000099'
  let records = Array.from({ length: 8 }, (_, index) => askItemSchema.parse({
    request_id: `00000000-0000-4000-8000-00000000000${index}`, conversation_id: conversationId,
    question: `Question ${index}`, input_mode: 'text', context: { anchor: { kind: 'work', page_id: fixtureId(1), label: 'Long conversation', url: null, observed_at: null }, view: { scene: 'overview' } },
    created_at: `2026-11-10T10:0${index}:00Z`, updated_at: `2026-11-10T10:0${index}:30Z`, answered_at: `2026-11-10T10:0${index}:30Z`, status: 'answered',
    reply: { summary: `Answer ${index}`, detail: 'Read [supporting report](https://example.test/report). Retained context and supporting evidence. '.repeat(20), references: [], suggested_actions: [] }, read_at: null, dismissed_at: null, error: null,
  }))
  await page.route('**/api/ask/requests', route => route.fulfill({ json: { ok: true, data: records } }))
  await page.route('**/api/ask/requests/*/read', route => {
    records = records.map(record => route.request().url().includes(record.request_id) ? { ...record, read_at: new Date().toISOString() } : record)
    return route.fulfill({ json: { ok: true, data: {} } })
  })
  await page.goto(base)
  await page.locator('.ask-preview').click()
  const viewport = page.locator('.ask-messages')
  await expect(viewport.getByRole('link', { name: 'supporting report' }).first()).toHaveAttribute('href', 'https://example.test/report')
  await expect.poll(() => viewport.evaluate(element => element.scrollTop > 0)).toBe(true)
  await viewport.evaluate(element => { element.scrollTop = 100; element.dispatchEvent(new Event('scroll')) })
  records = [...records, { ...records[7]!, request_id: '00000000-0000-4000-8000-000000000099', question: 'Latest follow-up', read_at: null, created_at: '2026-11-10T10:09:00Z', updated_at: '2026-11-10T10:09:30Z', answered_at: '2026-11-10T10:09:30Z', reply: { summary: 'New evidence arrived', detail: 'New evidence arrived', references: [], suggested_actions: [] } }]
  await expect(viewport.getByText('New evidence arrived', { exact: true })).toBeAttached({ timeout: 10000 })
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(100)
  await page.getByRole('button', { name: 'Read new answer' }).click()
  await expect.poll(() => viewport.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2)
  await expect(page.getByRole('textbox', { name: 'Reply to First Mate' })).toBeVisible()
})

test('phone workbench navigation and Full conversation return preserve the exact request and one visible composer', async ({ page }) => {
  const item = fixtureQueue().items[0]!
  const record = askItemSchema.parse({ request_id: '00000000-0000-4000-8000-000000000010', conversation_id: '10000000-0000-4000-8000-000000000010',
    question: 'Explain this request', input_mode: 'text', context: {
      anchor: { kind: 'decision', page_id: item.cardIds[0]!, label: 'Fixture decision', url: null, observed_at: null },
      target: { kind: 'decision', id: item.id }, view: { scene: 'decisions', request_key: item.id, query: 'Build' },
      return_to: { section: 'decisions', target: { kind: 'decision', id: item.id }, view: { scene: 'decisions', request_key: item.id, query: 'Build' } },
    }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status: 'answered',
    reply: { summary: 'Evidence for this exact request', detail: '', references: [], suggested_actions: [] }, error: null, read_at: null, dismissed_at: null,
  })
  await page.route('**/api/ask/requests', route => route.fulfill({ json: { ok: true, data: [record] } }))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${base}/?view=decisions`)
  await page.locator('.decisions-row').first().click()
  const detail = page.getByLabel('Selected decision')
  await expect(detail).toHaveAttribute('data-decision-id', item.id)
  await detail.getByRole('button', { name: 'Next decision →' }).click()
  await expect(detail).not.toHaveAttribute('data-decision-id', item.id)
  await detail.getByRole('button', { name: '← Previous' }).click()
  await expect(detail).toHaveAttribute('data-decision-id', item.id)
  await detail.getByRole('button', { name: 'Full conversation ↗' }).click()
  const desk = page.getByRole('dialog', { name: 'Discuss' })
  await expect(desk.getByRole('textbox', { name: 'Reply to First Mate' })).toBeVisible()
  await expect(detail.locator('.ask-composer')).toHaveCount(0)
  await desk.getByRole('button', { name: 'Return to source' }).click()
  await expect(desk).toBeHidden()
  await expect(detail).toBeVisible()
  await expect(detail).toHaveAttribute('data-decision-id', item.id)
  await expect(page.locator('.decisions-search input')).toHaveValue('Build')
  await expect(detail.locator('.ask-composer')).toHaveCount(1)
  await page.reload()
  await expect(detail).toBeVisible()
  await expect(detail).toHaveAttribute('data-decision-id', item.id)
  await expect(page.locator('.decisions-search input')).toHaveValue('Build')
})

import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decideStaticServe } from '../src/server/staticServe'
import { fixtureId, fixtureScene } from '../test-fixtures/reconciliation/scenes'

// A real built client with isolated API fixtures; manual preview proof uses real sources.
let server: ReturnType<typeof createServer>, base: string
const client = resolve('dist/client')
test.beforeAll(async () => {
  server = createServer((req, res) => {
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
test('one persistent Desk across sections with pointer/keyboard sizing and reload preferences', async ({ page }) => {
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
})
test('one accessible mobile sheet retains its inbox on close and section navigation', async ({ page }) => {
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

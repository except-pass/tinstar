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

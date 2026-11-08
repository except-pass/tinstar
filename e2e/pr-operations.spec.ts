import { expect, test } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decideStaticServe } from '../src/server/staticServe'
import { fixtureScene } from '../test-fixtures/reconciliation/scenes'
import { releaseAssociations } from '../src/shared/releases'
import type { PullSummary } from '../src/shared/pulls'

// Serve the real built client. All API fixtures are isolated at the browser boundary.
const client = resolve('dist/client')
let server: ReturnType<typeof createServer>, base: string

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

test('50 PRs: repository sort, 10 selections, keyboard inline detail, head refresh and 390px navigation', async ({ page }) => {
  let head = 'a'.repeat(40)
  const scene = fixtureScene()
  for (const worker of scene.executions.slice(0, 2)) worker.source.pr = { url: 'https://github.com/alpha/repo/pull/1', head, source: 'fixture registration' }
  scene.executions[1]!.liveness = 'finished'
  scene.backlog.push({ id: 'retired-registration', home: '/fixture/retired', observation: scene.executions[0]!.observation, source: { ...scene.backlog[0]!.source, id: 'retired-task', state: 'done', pr_url: 'https://github.com/alpha/repo/pull/1' } })

  const inventory = (): PullSummary[] => Array.from({ length: 50 }, (_, i) => {
    const repository = i < 25 ? 'alpha/repo' : 'zeta/repo'
    return { id: `${repository}#${i + 1}`, repository, number: i + 1, url: `https://github.com/${repository}/pull/${i + 1}`,
      title: `Review change ${i + 1}`, author: 'author', draft: false, head, base: 'main', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-06T20:00:00Z', observedAt: new Date().toISOString(), freshness: 'fresh', links: releaseAssociations(scene).pulls.find(pull => pull.id === `${repository}#${i + 1}`)?.links ?? [] }
  })
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/quota') { await route.fulfill({ json: { providers: [], checkedAt: null, fetchedAt: null, commandError: null } }); return }
    const data = url.pathname === '/api/pulls' ? { pulls: inventory(), repositories: [{ repository: 'alpha/repo', status: 'fresh', complete: true, observedAt: new Date().toISOString(), error: null }], warnings: [], associationsComplete: true }
      : url.pathname === '/api/pulls/files' ? { head, baseHead: 'c'.repeat(40), expectedFiles: 3, complete: true, freshness: 'fresh', error: null, observedAt: new Date().toISOString(), files: [
        { filename: 'src/code.ts', previousFilename: null, status: 'modified', additions: 2, deletions: 1, changes: 3, category: 'Code', url: 'https://github.com/alpha/repo/pull/1/files#diff-code' },
        { filename: 'package-lock.json', previousFilename: null, status: 'modified', additions: 9997, deletions: 0, changes: 9997, category: 'Generated & Dependencies', url: 'https://github.com/alpha/repo/pull/1/files#diff-lock' },
        { filename: 'new.bin', previousFilename: 'old.bin', status: 'renamed', additions: 0, deletions: 0, changes: 0, category: 'Other', url: 'https://github.com/alpha/repo/pull/1/files#diff-binary' },
      ] } : url.pathname === '/api/pulls/detail' ? { head, state: 'open', body: `Description at ${head.slice(0, 8)}`, bodyTruncated: false, additions: 7, deletions: 2, files: 3, checks: 'failed', reviews: [], review: 'No approval observed', reviewsComplete: true, freshness: 'fresh', observedAt: new Date().toISOString(), error: null }
        : url.pathname === '/api/fleet' ? { ready: true, workers: [], attention: [], errors: [] }
          : url.pathname === '/api/fleet/messages' ? []
            : url.pathname === '/api/reconciliation/scene' ? { ...scene, searchIndex: { documents: [], notes: [] } }
              : url.pathname === '/api/releases' ? { pulls: [], unassociatedCards: [], warnings: [], associationsComplete: true, associationsWritable: false } : {}
    await route.fulfill({ json: { ok: true, data } })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${base}/?view=pulls`)
  await expect(page.locator('.pr-row')).toHaveCount(50)
  const rail = page.getByRole('navigation', { name: 'Activity' })
  await expect(rail.getByRole('button', { name: /Receipts|Workers/ })).toHaveCount(0)
  await expect(rail.getByRole('button', { name: 'PRs', exact: true })).toHaveAttribute('aria-current', 'page')
  await page.getByRole('button', { name: 'Repository ↑' }).click()
  await expect(page.locator('.pr-row').first()).toContainText('zeta/repo')
  await page.getByRole('button', { name: 'Repository ↓' }).click()
  for (let i = 1; i <= 10; i++) await page.getByRole('checkbox', { name: `Select alpha/repo#${i}`, exact: true }).check()
  await expect(page.getByText('10 selected')).toBeVisible()
  const inspect = page.getByRole('button', { name: 'Inspect alpha/repo#1', exact: true })
  await inspect.focus(); await page.keyboard.press('Enter')
  await expect(page.getByText('Description at aaaaaaaa')).toBeVisible()
  await expect(page.getByRole('heading', { name: /Change footprint · 3 \/ 3 files · Complete/ })).toBeVisible()
  await page.getByRole('checkbox', { name: 'Exclude generated & dependencies' }).check()
  await page.getByRole('button', { name: /Code: 100.0%/ }).click()
  await expect(page.getByRole('link', { name: 'src/code.ts', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'package-lock.json', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '#1 Review change 1', exact: true })).toHaveAttribute('href', 'https://github.com/alpha/repo/pull/1')
  head = 'b'.repeat(40)
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByText('Description at aaaaaaaa')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: /Change footprint/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Read current detail' }).click()
  await expect(page.getByText('Description at bbbbbbbb')).toBeVisible()
  await expect(page.locator('.pr-contributor')).toHaveCount(3)
  await expect(page.getByText(/worker retired-task/)).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('fixture-footprint-contributors-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('heading', { name: /Change footprint/ }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: test.info().outputPath('fixture-footprint-mobile.png') })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.setViewportSize({ width: 1440, height: 900 })
  await inspect.click()
  await page.screenshot({ path: test.info().outputPath('fixture-50-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(rail.getByRole('button', { name: /Receipts|Workers/ })).toHaveCount(0)
  expect(await page.locator('.pr-scroll').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true)
  await page.locator('.pr-scroll').evaluate(el => { el.scrollLeft = 0 })
  await page.screenshot({ path: test.info().outputPath('fixture-50-mobile.png') })
  await rail.getByRole('button', { name: /Releases/ }).click()
  await expect(page).toHaveURL(/view=releases/)
  await page.goBack()
  await expect(page.locator('.pr-row')).toHaveCount(50)
  await expect(page.locator('.cockpit-context')).toBeHidden()
})

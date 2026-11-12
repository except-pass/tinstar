import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { fixtureScene, fixtureViewerWorkers, fixtureQueue } from '../test-fixtures/reconciliation/scenes'
import { MAIN_WAIT_INTERVAL, type MainWaitRead } from '../src/shared/waitingOnMain'

let server: ChildProcess | undefined, root: string, base: string
// Keep manual/worker previews in the assigned range. CI owns its test machine.
async function previewPort() {
  for (const port of [5295, 5296, 5294, 5293]) {
    const probe = createServer()
    const free = await new Promise<boolean>(resolve => { probe.once('error', () => resolve(false)); probe.listen(port, '127.0.0.1', () => resolve(true)) })
    if (free) { await new Promise<void>(resolve => probe.close(() => resolve())); return port }
  }
  throw new Error('No assigned preview port available (5293–5296)')
}
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'tinstar-main-wait-preview-'))
  await mkdir(join(root, 'config'))
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin', 'quota-axi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await writeFile(join(root, 'config', 'config.json'), JSON.stringify({ firstmate: { homes: [] }, reconciliation: { fleet: [] }, waitingOnMain: { deliveryEnabled: false } }))
  base = `http://127.0.0.1:${await previewPort()}`
  server = spawn(process.execPath, ['--import', 'tsx', 'src/server/standalone.ts', '--port', new URL(base).port, '--no-open'], {
    env: { ...process.env, HOME: root, PATH: `${join(root, 'bin')}:${process.env.PATH}`, TINSTAR_CONFIG_HOME: join(root, 'config'), TINSTAR_STATE_HOME: join(root, 'state'), TINSTAR_NO_SESSIONS: '1', TINSTAR_TELEMETRY: '0', TINSTAR_NO_PORT_FALLBACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  server.stdout?.on('data', data => { output += data.toString() })
  server.stderr?.on('data', data => { output += data.toString() })
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`${base}/api/reconciliation/scene`)).ok) return } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  await writeFile(join(root, 'failed-start.log'), output)
  throw new Error(`Preview failed to start: ${root}/failed-start.log`)
})
test.afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) {
    const closed = new Promise<void>(resolve => server!.once('close', () => resolve()))
    server.kill(); await closed
  }
  if (root) await rm(root, { recursive: true, force: true })
})

test('Overview hides waits on First Mate until a nudge has been open for 2h', async ({ page }) => {
  const now = Date.now()
  await page.clock.install({ time: now })
  await page.setViewportSize({ width: 1440, height: 900 })
  const waits: MainWaitRead = { unknown: ['Hulk: parent asks unknown or stale'], items: [
    { id: 'card:rollout', source: 'board', kind: 'card', label: 'Rollout approval', key: 'card-rollout', text: 'First Mate (main): review rollout', since: new Date(now - MAIN_WAIT_INTERVAL).toISOString(), ageBasis: 'at least', fresh: true, url: 'https://www.notion.so/00000000000000000000000000000004' },
    { id: 'mate:api', source: 'mate:hulk', kind: 'mate', label: 'Hulk', key: 'api-choice', text: 'Choose the API version', since: new Date(now - 3600_000).toISOString(), ageBasis: 'status timestamp', fresh: false, url: null, alert: 'plain-comment' },
  ] }
  const scene = { ...fixtureScene({ now }), waitingOnMain: waits }
  await page.route('**/api/reconciliation/scene*', route => route.fulfill({ json: { ok: true, data: scene } }))
  await page.route('**/api/reconciliation/queue*', route => route.fulfill({ json: { ok: true, data: fixtureQueue() } }))
  await page.route('**/api/fleet', route => route.fulfill({ json: { ok: true, data: { ready: true, workers: fixtureViewerWorkers(), attention: [], errors: [] } } }))
  await page.goto(base)
  await expect(page.getByRole('region', { name: 'Overview' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Waiting on First Mate' })).toHaveCount(0)
  waits.items[0]!.nudgedAt = new Date(now - 2 * 3600_000).toISOString()
  await page.clock.runFor(60_000)
  const waitsPanel = page.getByRole('region', { name: 'Waiting on First Mate', exact: true })
  await expect(waitsPanel.getByRole('button')).toHaveText('First Mate nudge still open')
  await expect(waitsPanel).toHaveAttribute('data-overdue', 'false')
  await expect(waitsPanel.getByRole('button')).not.toContainText('coverage')
  await waitsPanel.getByRole('button').click()
  await expect(waitsPanel.getByRole('link', { name: 'Rollout approval' })).toBeVisible()
  await expect(waitsPanel).toContainText('Hulk')
  await expect(waitsPanel).toContainText('api-choice')
  await expect(waitsPanel).toContainText('Choose the API version')
  const undeliveredItem = waitsPanel.getByRole('article').filter({ hasText: 'api-choice' })
  await expect(undeliveredItem.getByRole('status')).toContainText('Owner alert not delivered (mention failed)')
  await page.clock.runFor(60_000)
  await expect(waitsPanel.getByRole('button')).toHaveText('First Mate nudge still open')
  await expect(waitsPanel).toHaveAttribute('data-overdue', 'false')
})

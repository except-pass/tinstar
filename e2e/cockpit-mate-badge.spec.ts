import { test, expect } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')

test('a second mate shows a badge on the overview card and in the detail rail', async ({ page, request }) => {
  test.setTimeout(60_000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-mate-badge-'))
  const home = join(root, 'firstmate')
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const socket = `cockpit-badge-${process.pid}-${Date.now()}`
  const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
  const port = 39000 + Math.floor(Math.random() * 10000)
  let server: ChildProcess | null = null
  const task = (id: string, kind: string, objective: string) => ({
    id, kind, project: 'tinstar', branch: `fm/${id}`,
    paths: { worktree: { path: `/private/worktrees/${id}` } },
    current_state: {
      state: 'working', source: 'status-log', detail: `${id} is on the current change`,
      observed_at: '2026-09-29T12:00:00Z', freshness: 'fresh',
    },
    endpoint: { target: null, exists: true, agent_alive: 'alive', status: 'alive' },
    hints: { last_event_text: `working [at=1790000000]: ${id} is on the current change` },
    pr: { url: null },
    backlog: { title: objective },
  })
  try {
    for (const path of [home, config, bin, join(home, 'bin'), join(home, 'state')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -L '${socket}' -f /dev/null "$@"\n`)
    chmodSync(join(bin, 'tmux'), 0o755)
    writeFileSync(join(config, 'config.json'), JSON.stringify({ firstmate: { homes: [home] } }))
    writeFileSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), `#!/bin/sh\ncat '${join(home, 'snapshot.json')}'\n`)
    chmodSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), 0o755)
    writeFileSync(join(home, 'snapshot.json'), JSON.stringify({
      schema: 'fm-fleet-snapshot.v1',
      tasks: [
        task('harbor', 'secondmate', 'Keep the next task moving'),
        task('keel', 'ship', 'Ship the editor'),
        task('lookout', 'scout', 'Look over the change'),
      ],
      backlog: { records: [] },
    }))
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TINSTAR_CONFIG_HOME: config, TINSTAR_NO_SESSIONS: '1', TINSTAR_CORS_ORIGINS: `http://127.0.0.1:${port}` }
    delete env.TMUX
    delete env.TMUX_PANE
    server = spawn(join(repo, 'node_modules', '.bin', 'tsx'), ['src/server/standalone.ts', '--port', String(port), '--no-open'], { cwd: repo, env, stdio: 'ignore' })
    const base = `http://127.0.0.1:${port}`
    await expect.poll(async () => {
      if (server?.exitCode !== null) throw new Error(`server exited: ${server?.exitCode}`)
      try { return (await request.get(`${base}/api/fleet`, { timeout: 1000 }).then(response => response.json()) as { data?: { workers?: unknown[] } }).data?.workers?.length ?? 0 }
      catch { return 0 }
    }, { timeout: 15_000 }).toBe(3)
    const fleet = await request.get(`${base}/api/fleet`).then(response => response.json()) as { data: { workers: Array<{ id: string; kind: string }> } }
    expect(fleet.data.workers.map(worker => [worker.id, worker.kind])).toEqual([
      ['harbor', 'secondmate'],
      ['keel', 'ship'],
      ['lookout', 'scout'],
    ])
    const card = (id: string) => page.locator('.cockpit-card').filter({ has: page.locator('strong', { hasText: new RegExp(`^${id}$`) }) })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(base)
    await expect(card('harbor').locator('.cockpit-mate')).toHaveText('Second mate')
    await expect(card('keel').locator('.cockpit-mate')).toHaveCount(0)
    await expect(card('lookout').locator('.cockpit-mate')).toHaveCount(0)
    expect((await page.locator('.cockpit-group-heading').allTextContents()).join('\n')).not.toContain('Second mate')
    await expect(card('harbor').getByRole('button', { name: 'harbor Managed' })).toBeVisible()
    await expect(card('keel').getByRole('button', { name: 'keel Managed' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('private-mate-badge-overview-1440x900.png') })
    await card('harbor').locator('strong').click()
    await expect(page.getByRole('heading', { name: 'harbor' })).toBeVisible()
    await expect(page.locator('.cockpit-detail-rail .cockpit-worker-marks .cockpit-mate')).toHaveText('Second mate')
    await expect(page.locator('.cockpit-detail-rail .cockpit-status-detail .cockpit-mate')).toBeHidden()
    await expect(page.locator('.cockpit-detail-rail').getByRole('button', { name: 'harbor Managed' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('private-mate-badge-detail-1440x900.png') })
    await page.locator('.cockpit-worker-button', { hasText: 'keel' }).click()
    await expect(page.getByRole('heading', { name: 'keel' })).toBeVisible()
    await expect(page.locator('.cockpit-mate')).toHaveCount(0)
    await page.locator('.cockpit-worker-button', { hasText: 'lookout' }).click()
    await expect(page.getByRole('heading', { name: 'lookout' })).toBeVisible()
    await expect(page.locator('.cockpit-mate')).toHaveCount(0)
    await page.locator('.cockpit-worker-button', { hasText: 'harbor' }).click()
    const headerInside = () => page.evaluate(() => {
      const rail = document.querySelector('.cockpit-detail-rail')!
      const railBottom = rail.getBoundingClientRect().bottom
      const problems: string[] = []
      if (rail.getBoundingClientRect().height > 64) problems.push('detail rail grew past the slim header')
      for (const selector of ['h1', '.cockpit-direct', '[aria-label="Previous worker"]', '[aria-label="Next worker"]', '.cockpit-detail-summary']) {
        const item = rail.querySelector(selector)?.getBoundingClientRect()
        if (!item || item.width < 8 || item.bottom > railBottom + 1) problems.push(`${selector} is outside the slim header`)
      }
      const heading = rail.querySelector('h1')
      if (!heading || heading.scrollWidth > heading.clientWidth + 1) problems.push('worker name is clipped')
      return problems
    })
    await page.setViewportSize({ width: 800, height: 900 })
    await expect(page.locator('.cockpit-detail-rail .cockpit-worker-marks .cockpit-mate')).toBeVisible()
    await expect.poll(headerInside).toEqual([])
    await page.screenshot({ path: test.info().outputPath('private-mate-badge-detail-800x900.png') })
    await page.setViewportSize({ width: 720, height: 900 })
    await expect(page.locator('.cockpit-detail-rail .cockpit-worker-marks .cockpit-mate')).toBeHidden()
    await page.locator('.cockpit-detail-summary').click()
    await expect(page.locator('.cockpit-detail-rail .cockpit-status-detail .cockpit-mate')).toHaveText('Second mate')
    await page.locator('.cockpit-detail-summary').click()
    await expect.poll(headerInside).toEqual([])
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('.cockpit-detail-rail .cockpit-worker-marks .cockpit-mate')).toBeHidden()
    await page.locator('.cockpit-detail-summary').evaluate(button => (button as HTMLButtonElement).click())
    await expect(page.locator('.cockpit-detail-rail .cockpit-status-detail .cockpit-mate')).toHaveText('Second mate')
    await page.screenshot({ path: test.info().outputPath('private-mate-badge-detail-390x844.png') })
    await page.getByRole('button', { name: 'Overview' }).click()
    const phoneBadge = card('harbor').locator('.cockpit-mate')
    await expect(phoneBadge).toHaveText('Second mate')
    expect(await phoneBadge.evaluate(el => el.scrollWidth > el.clientWidth + 1)).toBe(false)
    await expect(card('keel').locator('.cockpit-mate')).toHaveCount(0)
    await expect(card('lookout').locator('.cockpit-mate')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('private-mate-badge-overview-390x844.png') })
  } finally {
    server?.kill('SIGTERM')
    try { execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', 'kill-server'], { stdio: 'ignore' }) } catch { /* private server absent */ }
    rmSync(root, { recursive: true, force: true })
  }
})

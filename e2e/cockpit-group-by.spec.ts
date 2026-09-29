import { test, expect } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')
const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('overview groups a private fleet by status and project and remembers the choice', async ({ browser }) => {
  test.setTimeout(90_000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-group-by-'))
  const home = join(root, 'firstmate')
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const socket = `group-by-${process.pid}-${Date.now()}`
  const port = 39000 + Math.floor(Math.random() * 10000)
  let server: ChildProcess | null = null
  const tmux = (...args: string[]) => execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 10_000 }).trim()
  const crew = [
    ['helm', 'working', 'tinstar'],
    ['keel', 'working', 'firstmate'],
    ['spar', 'blocked', 'tinstar'],
    ['tiller', 'blocked', 'stretchplan'],
  ] as const
  try {
    for (const path of [home, config, bin, join(home, 'bin'), join(home, 'state')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(config, 'config.json'), JSON.stringify({ firstmate: { homes: [home], ports: { start: 52000, count: 4 } } }))
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -L '${socket}' -f /dev/null "$@"\n`)
    chmodSync(join(bin, 'tmux'), 0o755)
    writeFileSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), `#!/bin/sh\ncat '${join(home, 'snapshot.json')}'\n`)
    chmodSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), 0o755)
    writeFileSync(join(home, 'snapshot.json'), JSON.stringify({
      schema: 'fm-fleet-snapshot.v1',
      tasks: crew.map(([id, state, project]) => ({
        id, kind: 'worker', project, branch: `fm/${id}`,
        paths: { worktree: { path: `/private/worktrees/${id}` } },
        current_state: { state, detail: `${id} on the current change`, observed_at: '2026-09-28T12:00:00Z', freshness: 'fresh' },
        endpoint: { target: null }, pr: { url: null },
        backlog: { title: `${id} keeps the fleet in view` },
      })),
      backlog: { records: [] },
    }))
    tmux('new-session', '-d', '-s', 'firstmate', '-x', '80', '-y', '24', '-n', 'supervisor')
    const env: NodeJS.ProcessEnv = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, TINSTAR_CONFIG_HOME: config,
      TINSTAR_NO_SESSIONS: '1', TINSTAR_CORS_ORIGINS: `http://127.0.0.1:${port}`,
    }
    delete env.TMUX
    delete env.TMUX_PANE
    server = spawn(join(repo, 'node_modules', '.bin', 'tsx'), ['src/server/standalone.ts', '--port', String(port), '--no-open'], {
      cwd: repo, env, stdio: 'ignore',
    })
    const base = `http://127.0.0.1:${port}`
    for (let i = 0; i < 100; i++) {
      try {
        const body = await fetch(`${base}/api/fleet`).then(response => response.json()) as { data?: { workers: unknown[] } }
        if (body.data?.workers.length === 4) break
      } catch { /* starting */ }
      await delay(200)
    }
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    await page.goto(base)
    await expect(page.locator('.cockpit-worker-button')).toHaveCount(4)
    await expect(page.getByRole('combobox', { name: 'Group by' })).toHaveValue('status')
    await expect(page.getByRole('combobox', { name: 'Then by' })).toHaveValue('project')
    const primary = page.locator('.cockpit-group')
    await expect(primary).toHaveCount(2)
    await expect(primary.nth(0).locator('.cockpit-group-heading').first()).toContainText('working')
    await expect(primary.nth(0).locator('.cockpit-subgroup')).toHaveCount(2)
    await expect(primary.nth(0).locator('.cockpit-card strong')).toHaveText(['helm', 'keel'])
    await expect(primary.nth(1).locator('.cockpit-card strong')).toHaveText(['spar', 'tiller'])
    await page.screenshot({ path: test.info().outputPath('group-by-status-project-1440x900.png'), fullPage: true })

    await page.getByRole('combobox', { name: 'Group by' }).selectOption('project')
    await expect(page.getByRole('combobox', { name: 'Group by' })).toHaveValue('project')
    await expect(page.getByRole('combobox', { name: 'Then by' })).toHaveValue('status')
    await expect(primary).toHaveCount(3)
    await expect(primary.nth(0).locator('.cockpit-group-label').first()).toHaveText('tinstar')
    await expect(primary.nth(0).locator('.cockpit-card strong')).toHaveText(['helm', 'spar'])
    await expect(primary.nth(1).locator('.cockpit-card strong')).toHaveText(['keel'])
    await expect(primary.nth(2).locator('.cockpit-card strong')).toHaveText(['tiller'])
    await page.locator('.cockpit-card').filter({ hasText: 'keel' }).click()
    await expect(page.getByRole('heading', { name: 'keel' })).toBeVisible()
    await expect(page.locator('.cockpit-facts')).toContainText('firstmate')
    await page.getByRole('button', { name: 'Overview' }).click()
    await expect(page.getByRole('combobox', { name: 'Group by' })).toHaveValue('project')
    expect(await page.evaluate(() => localStorage.getItem('tinstar-cockpit-group-by'))).toBe('{"primary":"project","secondary":"status"}')
    await page.screenshot({ path: test.info().outputPath('group-by-project-status-1440x900.png'), fullPage: true })

    await page.setViewportSize({ width: 760, height: 900 })
    await expect(primary.nth(0).locator('.cockpit-card strong')).toHaveText(['helm', 'spar'])
    await page.screenshot({ path: test.info().outputPath('group-by-project-status-760x900.png'), fullPage: true })

    await page.reload()
    await expect(page.getByRole('combobox', { name: 'Group by' })).toHaveValue('project')
    await expect(page.getByRole('combobox', { name: 'Then by' })).toHaveValue('status')
    await expect(page.locator('.cockpit-group')).toHaveCount(3)
    expect(tmux('display-message', '-p', '-t', 'firstmate', '#S')).toBe('firstmate')
    await page.close()
  } finally {
    server?.kill('SIGTERM')
    try { tmux('kill-server') } catch { /* private server already gone */ }
    rmSync(root, { recursive: true, force: true })
  }
})

import { test, expect } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')

test('a second mate whose last status line is a child done shows working or idle', async ({ page, request }) => {
  test.setTimeout(60_000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-mate-status-'))
  const home = join(root, 'firstmate')
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const socket = `cockpit-mate-${process.pid}-${Date.now()}`
  const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
  const port = 39000 + Math.floor(Math.random() * 10000)
  let server: ChildProcess | null = null
  const childLine = (state: string, detail: string) =>
    detail.replace(/^child (\S+) (\w+): /, (_, child, verb) => `${state} [key=child-outcome-${child}-${verb}-05b032a1] [at=1790000000]: child ${child} ${verb}: `)
  const task = (id: string, kind: string, state: string, detail: string, project: string) => ({
    id, kind, project, branch: `fm/${id}`,
    paths: {
      worktree: { path: `/private/worktrees/${id}` },
      status_log: { last_event: { raw: kind === 'secondmate' ? childLine(state, detail) : `${state}: ${detail}`, note: detail, state } },
    },
    current_state: {
      state, source: 'status-log', detail,
      raw: `state: ${state} · source: status-log · ${detail}`,
      observed_at: '2026-09-29T12:00:00Z', freshness: 'fresh',
    },
    endpoint: { target: null, exists: true, agent_alive: 'alive', status: 'alive' },
    hints: { last_event_text: kind === 'secondmate' ? childLine(state, detail) : `${state} [at=1790000000]: ${detail}` },
    pr: { url: null },
  })
  try {
    for (const path of [home, config, bin, join(home, 'bin'), join(home, 'state')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -L '${socket}' -f /dev/null "$@"\n`)
    chmodSync(join(bin, 'tmux'), 0o755)
    writeFileSync(join(bin, 'quota-axi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(config, 'config.json'), JSON.stringify({ firstmate: { homes: [home] } }))
    writeFileSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), `#!/bin/sh\ncat '${join(home, 'snapshot.json')}'\n`)
    chmodSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), 0o755)
    writeFileSync(join(home, 'snapshot.json'), JSON.stringify({
      schema: 'fm-fleet-snapshot.v1',
      tasks: [
        task('busy-mate', 'secondmate', 'done', 'child widget done: report complete', 'private-busy'),
        task('kd', 'secondmate', 'done', 'child kd-widget done: report and visual review complete', 'private-kd'),
        task('fail-mate', 'secondmate', 'failed', 'child gadget failed: build broke on main', 'private-fail'),
        task('ship-done', 'ship', 'done', 'checks green', 'private-ship'),
      ],
      backlog: { records: [
        { id: 'busy-mate', title: 'Keep dispatching the next task' },
        { id: 'kd', title: 'Stay available for the next task' },
        { id: 'fail-mate', title: 'Stay available after a child failure' },
        { id: 'ship-done', title: 'Ship the editor' },
      ] },
      secondmate_current: { records: [
        { id: 'busy-mate', current: { state: 'active_child_work' }, active_children: [{ id: 'widget' }], counts: { active_children: 1 } },
        { id: 'kd', current: { state: 'no_active_work' }, active_children: [], counts: { active_children: 0 } },
        { id: 'fail-mate', current: { state: 'no_active_work' }, active_children: [], counts: { active_children: 0 } },
      ] },
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
    }, { timeout: 15_000 }).toBe(4)
    const fleet = await request.get(`${base}/api/fleet`).then(response => response.json()) as { data: { workers: Array<{ id: string; state: string; detail: string }>; attention: unknown[] } }
    expect(fleet.data.workers.map(worker => [worker.id, worker.state, worker.detail])).toEqual([
      ['busy-mate', 'working', 'child widget done: report complete'],
      ['kd', 'idle', 'child kd-widget done: report and visual review complete'],
      ['fail-mate', 'idle', 'child gadget failed: build broke on main'],
      ['ship-done', 'done', 'checks green'],
    ])
    expect(fleet.data.attention).toEqual([])
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(base)
    const chip = (id: string) => page.locator('.cockpit-worker-button', { hasText: id }).locator('.cockpit-state')
    const group = (id: string) => page.locator('.cockpit-group').filter({ has: page.locator('.cockpit-card strong', { hasText: new RegExp(`^${id}$`) }) })
    await expect(chip('busy-mate')).toHaveText('working')
    await expect(chip('kd')).toHaveText('idle')
    await expect(chip('fail-mate')).toHaveText('idle')
    await expect(chip('ship-done')).toHaveText('done')
    await expect(group('busy-mate').locator('.cockpit-group-heading .cockpit-state')).toHaveText('working')
    await expect(group('kd').locator('.cockpit-group-heading .cockpit-state')).toHaveText('idle')
    await expect(group('ship-done').locator('.cockpit-group-heading .cockpit-state')).toHaveText('done')
    const card = (id: string) => page.locator('.cockpit-card').filter({ has: page.locator('strong', { hasText: new RegExp(`^${id}$`) }) })
    await expect(card('kd').locator('small')).toHaveText('child kd-widget done: report and visual review complete')
    await expect(card('fail-mate').locator('small')).toHaveText('child gadget failed: build broke on main')
    await page.screenshot({ path: test.info().outputPath('private-mate-overview-1280x720.png') })
    await card('kd').click()
    await expect(page.getByRole('heading', { name: 'kd' })).toBeVisible()
    await expect(page.locator('.cockpit-worker-header .cockpit-state')).toHaveText('idle')
    await expect(page.locator('.cockpit-status-detail .cockpit-state')).toHaveText('idle')
    await expect(page.locator('.cockpit-status-detail')).toContainText('child kd-widget done: report and visual review complete')
    await page.screenshot({ path: test.info().outputPath('private-mate-detail-idle-1280x720.png') })
    await page.locator('.cockpit-worker-button', { hasText: 'busy-mate' }).click()
    await expect(page.getByRole('heading', { name: 'busy-mate' })).toBeVisible()
    await expect(page.locator('.cockpit-worker-header .cockpit-state')).toHaveText('working')
    await expect(page.locator('.cockpit-status-detail')).toContainText('child widget done: report complete')
    await page.locator('.cockpit-worker-button', { hasText: 'ship-done' }).click()
    await expect(page.getByRole('heading', { name: 'ship-done' })).toBeVisible()
    await expect(page.locator('.cockpit-worker-header .cockpit-state')).toHaveText('done')
    await page.getByRole('button', { name: 'Overview' }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(chip('kd')).toHaveText('idle')
    await expect(chip('busy-mate')).toHaveText('working')
    await expect(chip('ship-done')).toHaveText('done')
    await expect(group('kd').locator('.cockpit-group-heading .cockpit-state')).toHaveText('idle')
    await page.screenshot({ path: test.info().outputPath('private-mate-overview-390x844.png') })
  } finally {
    server?.kill('SIGTERM')
    try { execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', 'kill-server'], { stdio: 'ignore' }) } catch { /* private server absent */ }
    rmSync(root, { recursive: true, force: true })
  }
})

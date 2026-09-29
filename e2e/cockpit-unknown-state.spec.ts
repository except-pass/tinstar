import { test, expect } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')

test('an unknown worker shows its latest status report, and a dead endpoint stays unknown', async ({ page, request }) => {
  test.setTimeout(60_000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-unknown-state-'))
  const home = join(root, 'firstmate')
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const socket = `cockpit-unknown-${process.pid}-${Date.now()}`
  const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
  const port = 39000 + Math.floor(Math.random() * 10000)
  const age = 2 * 60 * 60 + 30 * 60
  let server: ChildProcess | null = null
  const task = (id: string, state: string, source: string, detail: string, verb: string, note: string, endpoint: { exists: boolean; agent_alive: string }) => ({
    id, kind: 'ship', project: 'tinstar', branch: `fm/${id}`,
    paths: {
      worktree: { path: `/private/worktrees/${id}` },
      status_log: { last_event: { state: verb, note, raw: `${verb} [at=1790000000]: ${note}`, age_seconds: age } },
    },
    current_state: { state, source, detail, observed_at: '2026-09-29T12:00:00Z', freshness: 'fresh' },
    endpoint: { target: null, ...endpoint, status: endpoint.agent_alive },
    hints: { last_event_text: `${verb} [at=1790000000]: ${note}` },
    pr: { url: null },
    backlog: { title: `${id} keeps the current change moving` },
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
        task('reported', 'unknown', 'pane', 'harness state unavailable', 'working', 'editing the worker view', { exists: true, agent_alive: 'alive' }),
        task('live', 'working', 'pane', 'harness busy', 'failed', 'build broke', { exists: true, agent_alive: 'alive' }),
        task('gone', 'unknown', 'pane', 'backend target gone', 'working', 'editing the worker view', { exists: false, agent_alive: 'dead' }),
        task('shell', 'unknown', 'none', 'backend target gone (agent gone, pane shell remains)', 'blocked', 'need access', { exists: true, agent_alive: 'not_checked' }),
      ],
      backlog: { records: [] },
    }))
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TINSTAR_CONFIG_HOME: config, TINSTAR_NO_SESSIONS: '1', TINSTAR_CORS_ORIGINS: `http://127.0.0.1:${port}` }
    delete env.NODE_ENV
    delete env.TMUX
    delete env.TMUX_PANE
    server = spawn(join(repo, 'node_modules', '.bin', 'tsx'), ['src/server/standalone.ts', '--port', String(port), '--no-open'], { cwd: repo, env, stdio: 'ignore' })
    const base = `http://127.0.0.1:${port}`
    await expect.poll(async () => {
      if (server?.exitCode !== null) throw new Error(`server exited: ${server?.exitCode}`)
      try { return (await request.get(`${base}/api/fleet`, { timeout: 1000 }).then(response => response.json()) as { data?: { workers?: unknown[] } }).data?.workers?.length ?? 0 }
      catch { return 0 }
    }, { timeout: 15_000 }).toBe(4)
    const fleet = await request.get(`${base}/api/fleet`).then(response => response.json()) as {
      data: { workers: Array<{ id: string; state: string; detail: string }>; attention: Array<{ type: string; workerId: string | null; headline: string }> }
    }
    const reported = 'editing the worker view · last report 2h ago'
    expect(fleet.data.workers.map(worker => [worker.id, worker.state, worker.detail])).toEqual([
      ['reported', 'working', reported],
      ['live', 'working', 'harness busy'],
      ['gone', 'unknown', 'backend target gone'],
      ['shell', 'unknown', 'backend target gone (agent gone, pane shell remains)'],
    ])
    expect(fleet.data.attention).toEqual([])
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(base)
    const chip = (id: string) => page.locator('.cockpit-worker-button', { hasText: id }).locator('.cockpit-state')
    const group = (id: string) => page.locator('.cockpit-group').filter({ has: page.locator('.cockpit-card strong', { hasText: new RegExp(`^${id}$`) }) })
    const card = (id: string) => page.locator('.cockpit-card').filter({ has: page.locator('strong', { hasText: new RegExp(`^${id}$`) }) })
    await expect(chip('reported')).toHaveText('working')
    await expect(chip('live')).toHaveText('working')
    await expect(chip('gone')).toHaveText('unknown')
    await expect(group('reported').locator('.cockpit-group-heading .cockpit-state')).toHaveText('working')
    await expect(group('gone').locator('.cockpit-group-heading .cockpit-state')).toHaveText('unknown')
    await expect(card('reported').locator('small')).toHaveText(reported)
    await expect(card('live').locator('small')).toHaveText('harness busy')
    await expect(card('gone').locator('small')).toHaveText('backend target gone')
    await page.screenshot({ path: test.info().outputPath('unknown-state-overview-1280x720.png') })
    await card('reported').click()
    await expect(page.getByRole('heading', { name: 'reported' })).toBeVisible()
    await expect(page.locator('.cockpit-worker-header .cockpit-state')).toHaveText('working')
    await expect(page.locator('.cockpit-status-detail .cockpit-state')).toHaveText('working')
    await expect(page.locator('.cockpit-status-detail')).toContainText(reported)
    await page.screenshot({ path: test.info().outputPath('unknown-state-detail-1280x720.png') })
    await page.getByRole('button', { name: 'Overview' }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(chip('reported')).toHaveText('working')
    await expect(chip('gone')).toHaveText('unknown')
    await expect(card('reported').locator('small')).toHaveText(reported)
    await expect(group('reported').locator('.cockpit-group-heading .cockpit-state')).toHaveText('working')
    await page.screenshot({ path: test.info().outputPath('unknown-state-overview-390x844.png') })
  } finally {
    server?.kill('SIGTERM')
    try { execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', 'kill-server'], { stdio: 'ignore' }) } catch { /* private server absent */ }
    rmSync(root, { recursive: true, force: true })
  }
})

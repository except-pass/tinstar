import { test, expect } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')

test('activity strip switches panels, opens a worker, and restores overview on back', async ({ browser }) => {
  test.setTimeout(90_000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-shell-'))
  const home = join(root, 'firstmate')
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const socket = `shell-${process.pid}-${Date.now()}`
  const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
  const port = 47000 + Math.floor(Math.random() * 8000)
  let server: ChildProcess | null = null
  const tmux = (...args: string[]) => execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 10_000 }).trim()
  try {
    for (const path of [home, config, bin, join(home, 'bin'), join(home, 'state')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -L '${socket}' -f /dev/null "$@"\n`)
    chmodSync(join(bin, 'tmux'), 0o755)
    writeFileSync(join(bin, 'quota-axi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(config, 'config.json'), JSON.stringify({ firstmate: { homes: [home], ports: { start: port + 1000, count: 8 } } }))
    writeFileSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), `#!/bin/sh\ncat '${join(home, 'snapshot.json')}'\n`)
    chmodSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), 0o755)
    mkdirSync(join(home, 'data', 'alpha'), { recursive: true })
    writeFileSync(join(home, 'data', 'alpha', 'brief.md'), '# Brief\n\n## Captain\'s intent\n\nChart the harbor lights\n')
    writeFileSync(join(home, 'snapshot.json'), JSON.stringify({
      schema: 'fm-fleet-snapshot.v1',
      tasks: [{
        id: 'alpha', kind: 'worker', project: 'alpha-project', branch: 'fm/alpha',
        paths: { worktree: { path: '/private/worktrees/alpha' } },
        current_state: { state: 'working', detail: 'alpha detail', observed_at: '2026-09-28T12:00:00Z', freshness: 'fresh' },
        endpoint: { target: 'firstmate:fm-alpha' }, pr: { url: null },
      }],
      backlog: { records: [{ id: 'alpha', title: 'alpha backlog title' }] },
    }))
    tmux('new-session', '-d', '-s', 'firstmate', '-n', 'supervisor')
    tmux('new-window', '-d', '-t', 'firstmate:', '-n', 'fm-alpha', "printf 'alpha> '; exec cat")
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
        const body = await fetch(`${base}/api/fleet`).then(response => response.json()) as { data?: { workers?: unknown[] } }
        if (body.data?.workers?.length === 1) break
      } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 200))
    }

    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
    await page.goto(base)
    await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible()
    await expect(page.getByText('Nothing needs you right now.')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Jump to worker' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Messages' }).click()
    await expect(page.getByText('No messages yet.')).toBeVisible()
    await expect(page.getByText('Nothing needs you right now.')).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible()
    expect(new URL(page.url()).searchParams.get('worker')).toBeNull()

    await page.getByRole('button', { name: 'Workers' }).click()
    await expect(page.getByRole('textbox', { name: 'Jump to worker' })).toBeVisible()
    await expect(page.locator('.cockpit-worker-button')).toHaveCount(1)
    await page.locator('.cockpit-worker-button', { hasText: 'alpha' }).click()
    await expect(page.getByRole('heading', { name: 'alpha' })).toBeVisible()
    await expect(page.locator('.cockpit-worker-button.active')).toContainText('alpha')
    await expect(page.locator('iframe[title="alpha terminal"]')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('.cockpit-detail-rail')).toBeVisible()

    await page.getByRole('button', { name: 'Close panel' }).click()
    await expect(page.getByRole('textbox', { name: 'Jump to worker' })).toHaveCount(0)
    await expect(page.locator('iframe[title="alpha terminal"]')).toBeVisible()
    expect(new URL(page.url()).searchParams.get('worker')).toBe('alpha')

    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible()
    await expect(page.getByText('Nothing needs you right now.')).toBeVisible()
    expect(new URL(page.url()).searchParams.get('worker')).toBeNull()

    await page.setViewportSize({ width: 1200, height: 800 })
    await page.getByRole('button', { name: 'Workers' }).click()
    await expect(page.locator('.cockpit-context')).toBeVisible()
    await expect(page.locator('.cockpit-worker-button')).toHaveCount(1)
    await page.screenshot({ path: test.info().outputPath('shell-medium-1200x800.png') })

    await page.setViewportSize({ width: 616, height: 800 })
    await page.goto(base)
    await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible()
    await expect(page.locator('.cockpit-context')).toBeHidden()
    await expect(page.locator('.cockpit-context-backdrop')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Overview' })).toHaveAttribute('title', 'Overview')
    expect(await page.locator('.cockpit-activity').evaluate(bar => {
      if (bar.scrollWidth > bar.clientWidth + 1) return false
      const barBox = bar.getBoundingClientRect()
      const lines = Array.from(bar.querySelectorAll('.cockpit-activity-line'))
      const words = lines.map(line => line.textContent)
      return words.join(' ') === 'Overview Needs You Messages Workers' && lines.every(line => {
        const box = line.getBoundingClientRect()
        return box.width > 8 && box.left >= barBox.left - 1 && box.right <= barBox.right + 1
      })
    })).toBe(true)
    await page.screenshot({ path: test.info().outputPath('shell-616-closed.png') })
    await page.getByRole('button', { name: 'Needs You' }).click()
    await expect(page.locator('.cockpit-context')).toBeVisible()
    await expect(page.locator('.cockpit-context-backdrop')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Close panel' })).toBeVisible()
    const backdrop = await page.locator('.cockpit-context-backdrop').boundingBox()
    expect(backdrop).toBeTruthy()
    await page.mouse.click(backdrop!.x + backdrop!.width - 12, backdrop!.y + 40)
    await expect(page.locator('.cockpit-context')).toBeHidden()
    await page.getByRole('button', { name: 'Needs You' }).click()
    await page.keyboard.press('Escape')
    await expect(page.locator('.cockpit-context')).toBeHidden()
    await page.getByRole('button', { name: 'Open alpha' }).click()
    await expect(page.getByRole('heading', { name: 'alpha' })).toBeVisible()
    await expect(page.locator('.cockpit-context')).toBeHidden()
    await expect(page.locator('iframe[title="alpha terminal"]')).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: test.info().outputPath('shell-616-worker.png') })
    await page.getByRole('button', { name: 'Workers' }).click()
    await expect(page.locator('.cockpit-context-backdrop')).toBeVisible()
    await page.getByRole('button', { name: 'Close panel' }).click()
    await expect(page.locator('.cockpit-context')).toBeHidden()
    await expect(page.getByRole('heading', { name: 'alpha' })).toBeVisible()
  } finally {
    server?.kill('SIGTERM')
    try { execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', 'kill-server'], { stdio: 'ignore' }) } catch { /* private server absent */ }
    rmSync(root, { recursive: true, force: true })
  }
})

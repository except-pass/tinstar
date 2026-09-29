import { test, expect } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')

test('overview filter and worker task-id link on a private fleet', async ({ browser }) => {
  test.setTimeout(90_000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-filter-link-'))
  const home = join(root, 'firstmate')
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const socket = `filter-link-${process.pid}-${Date.now()}`
  const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
  const port = 46000 + Math.floor(Math.random() * 8000)
  let server: ChildProcess | null = null
  const tmux = (...args: string[]) => execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 10_000 }).trim()
  const objectives: Record<string, string> = {
    alpha: 'Chart the harbor lights',
    bravo: 'Mend the north window',
  }
  try {
    for (const path of [home, config, bin, join(home, 'bin'), join(home, 'state')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -L '${socket}' -f /dev/null "$@"\n`)
    chmodSync(join(bin, 'tmux'), 0o755)
    writeFileSync(join(bin, 'quota-axi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(config, 'config.json'), JSON.stringify({ firstmate: { homes: [home], ports: { start: port + 1000, count: 8 } } }))
    writeFileSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), `#!/bin/sh\ncat '${join(home, 'snapshot.json')}'\n`)
    chmodSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), 0o755)
    for (const id of ['alpha', 'bravo']) {
      mkdirSync(join(home, 'data', id), { recursive: true })
      writeFileSync(join(home, 'data', id, 'brief.md'), `# Brief\n\n## Captain's intent\n\n${objectives[id]}\n\n## Firstmate spec\n\nOther text\n`)
    }
    writeFileSync(join(home, 'snapshot.json'), JSON.stringify({
      schema: 'fm-fleet-snapshot.v1',
      tasks: ['alpha', 'bravo'].map(id => ({
        id, kind: 'worker', project: `${id}-project`, branch: `fm/${id}`,
        paths: { worktree: { path: `/private/worktrees/${id}` } },
        current_state: { state: id === 'alpha' ? 'working' : 'blocked', detail: `${id} detail`, observed_at: '2026-09-28T12:00:00Z', freshness: 'fresh' },
        endpoint: { target: `firstmate:fm-${id}` }, pr: { url: null },
      })),
      backlog: { records: ['alpha', 'bravo'].map(id => ({ id, title: `${id} backlog title` })) },
    }))
    tmux('new-session', '-d', '-s', 'firstmate', '-n', 'supervisor')
    tmux('new-window', '-d', '-t', 'firstmate:', '-n', 'fm-alpha', "printf 'alpha> '; exec cat")
    tmux('new-window', '-d', '-t', 'firstmate:', '-n', 'fm-bravo', "printf 'bravo> '; exec cat")
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
        if (body.data?.workers?.length === 2) break
      } catch { /* starting */ }
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
    const cards = () => page.locator('.cockpit-card')
    const filter = page.getByRole('searchbox', { name: 'Filter workers' })
    await page.goto(base)
    await expect(page.locator('.cockpit-worker-button')).toHaveCount(2)
    await expect(cards()).toHaveCount(2)
    await expect(page.locator('.cockpit-group')).toHaveCount(2)

    await filter.pressSequentially('harbor')
    await expect(cards()).toHaveCount(1)
    await expect(cards()).toContainText('alpha')
    await expect(cards()).not.toContainText('bravo')
    await expect(page.locator('.cockpit-group')).toHaveCount(1)
    await expect(page.locator('.cockpit-worker-button')).toHaveCount(2)
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('harbor')
    await page.screenshot({ path: test.info().outputPath('filter-desktop.png') })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(filter).toBeVisible()
    await expect(cards()).toHaveCount(1)
    await page.screenshot({ path: test.info().outputPath('filter-mobile.png') })
    await page.setViewportSize({ width: 1280, height: 720 })

    await page.reload()
    await expect(filter).toHaveValue('harbor')
    await expect(cards()).toHaveCount(1)
    await expect(cards()).toContainText('Chart the harbor lights')

    await filter.press('Escape')
    await expect(filter).toHaveValue('')
    await expect(cards()).toHaveCount(2)
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBeNull()

    await page.locator('.cockpit-card', { hasText: 'alpha' }).click()
    await expect(page.getByRole('heading', { name: 'alpha' })).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get('worker')).toBe('alpha')
    await page.keyboard.press('Control+BracketRight')
    await expect(page.getByRole('heading', { name: 'bravo' })).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get('worker')).toBe('bravo')
    await page.goBack()
    await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get('worker')).toBeNull()

    await filter.fill('zzzz')
    await expect(page.getByText('No workers match.')).toBeVisible()
    await expect(cards()).toHaveCount(0)
    await filter.press('Escape')
    await expect(cards()).toHaveCount(2)

    await page.goto(`${base}/?worker=bravo`)
    await expect(page.getByRole('heading', { name: 'bravo' })).toBeVisible()
    await expect(page.locator('.cockpit-objective')).toContainText('Mend the north window')
    await expect.poll(() => new URL(page.url()).searchParams.get('worker')).toBe('bravo')
    await expect(page.locator('.cockpit-worker-button.active')).toContainText('bravo')
    await expect(page.locator('.cockpit-overview-button')).not.toHaveClass(/active/)
    await expect(page.locator('iframe[title="bravo terminal"]')).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: test.info().outputPath('worker-deep-link.png') })

    await page.getByRole('button', { name: 'Overview' }).click()
    await expect(page.getByRole('heading', { name: 'Workers' })).toBeVisible()
    await expect.poll(() => new URL(page.url()).searchParams.get('worker')).toBeNull()

    await page.goto(`${base}/?worker=alpha&q=window`)
    await expect(page.getByRole('heading', { name: 'alpha' })).toBeVisible()
    await page.getByRole('button', { name: 'Overview' }).click()
    await expect(filter).toHaveValue('window')
    await expect(cards()).toHaveCount(1)
    await expect(cards()).toContainText('bravo')

    await page.goto(`${base}/?worker=no-such-worker`)
    await expect(page.getByRole('heading', { name: 'No such worker' })).toBeVisible()
    await expect(page.locator('.cockpit-overview-button')).not.toHaveClass(/active/)
    await expect(page.locator('.cockpit-objective')).toHaveCount(0)
    await expect(page.locator('.cockpit-card')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('worker-missing.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByRole('heading', { name: 'No such worker' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('worker-missing-mobile.png') })

    writeFileSync(join(home, 'snapshot.json'), 'not json')
    await expect.poll(async () => {
      const body = await fetch(`${base}/api/fleet`).then(response => response.json()) as { data?: { errors?: string[] } }
      return body.data?.errors?.length ?? 0
    }, { timeout: 30_000 }).toBeGreaterThan(0)
    await page.goto(`${base}/?worker=no-such-worker`)
    await expect(page.getByRole('alert').filter({ hasText: 'Fleet update delayed' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'No such worker' })).toBeVisible()
    await page.close()
  } finally {
    server?.kill('SIGTERM')
    try { tmux('kill-server') } catch { /* private server already gone */ }
    rmSync(root, { recursive: true, force: true })
  }
})

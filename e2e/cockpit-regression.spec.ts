import { test, expect } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')
const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('regression: private First Mate fleet, terminal input, cycling and window survival', async ({ browser }) => {
  test.setTimeout(120_000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-cockpit-'))
  const home = join(root, 'firstmate')
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const socket = `cockpit-${process.pid}-${Date.now()}`
  const port = 39000 + Math.floor(Math.random() * 10000)
  const portStart = 49000 + Math.floor(Math.random() * 10000)
  let server: ChildProcess | null = null
  const tmux = (...args: string[]) => execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 10_000 }).trim()
  const windows = () => tmux('list-windows', '-t', 'firstmate', '-F', '#{window_id}:#{window_name}')
  const windowSizes = () => tmux('list-windows', '-t', 'firstmate', '-F', '#{window_id}:#{window_width}x#{window_height}')
  const task = (id: string) => ({
    id, kind: 'worker', project: `/private/projects/${id}`, branch: `fm/${id}`,
    paths: { worktree: { path: `/private/worktrees/${id}` } },
    current_state: { state: 'working', detail: `${id} active`, observed_at: '2026-09-28T12:00:00Z', freshness: 'fresh' },
    endpoint: { target: `firstmate:fm-${id}` }, pr: { url: null },
  })
  const snapshot = (ids: string[]) => writeFileSync(join(home, 'snapshot.json'), JSON.stringify({
    schema: 'fm-fleet-snapshot.v1', tasks: ids.map(task),
    backlog: { records: ids.map(id => ({ id, title: `${id} objective` })) },
  }))
  try {
    for (const path of [home, config, bin, join(home, 'bin'), join(home, 'state')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(config, 'config.json'), JSON.stringify({ firstmate: { homes: [home], ports: { start: portStart, count: 20 } } }))
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -L '${socket}' -f /dev/null "$@"\n`)
    chmodSync(join(bin, 'tmux'), 0o755)
    writeFileSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), `#!/bin/sh\ncat '${join(home, 'snapshot.json')}'\n`)
    chmodSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), 0o755)
    for (const id of ['alpha', 'bravo']) {
      mkdirSync(join(home, 'data', id), { recursive: true })
      writeFileSync(join(home, 'data', id, 'brief.md'), `# Brief\n\n## Captain's intent\n\n${id} brief objective\n\n## Firstmate spec\n\nOther text\n`)
    }
    snapshot(['alpha', 'bravo'])
    tmux('new-session', '-d', '-s', 'firstmate', '-n', 'supervisor')
    tmux('new-window', '-d', '-t', 'firstmate:', '-n', 'fm-alpha', 'cat')
    tmux('new-window', '-d', '-t', 'firstmate:', '-n', 'fm-bravo', 'cat')
    const before = windows()
    const sizesBefore = windowSizes()
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TINSTAR_CONFIG_HOME: config,
      TINSTAR_NO_SESSIONS: '1', TINSTAR_CORS_ORIGINS: `http://127.0.0.1:${port}` }
    delete env.TMUX
    delete env.TMUX_PANE
    server = spawn(join(repo, 'node_modules', '.bin', 'tsx'), ['src/server/standalone.ts', '--port', String(port), '--no-open'], {
      cwd: repo, env, stdio: 'ignore',
    })
    const base = `http://127.0.0.1:${port}`
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/api/fleet`).then(r => r.json()) as { data?: { workers: unknown[] } }).data?.workers.length === 2) break } catch { /* starting */ }
      await delay(200)
    }
    const page = await browser.newPage()
    await page.goto(base)
    await expect(page.locator('.cockpit-worker-button')).toHaveCount(2)
    const firstFace = page.locator('.cockpit-worker-button').first().locator('.cockpit-face')
    await expect(firstFace.locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml/)
    const firstFaceSrc = await firstFace.locator('img').getAttribute('src')
    const firstFaceColor = await firstFace.evaluate(el => getComputedStyle(el).borderColor)
    await page.getByRole('button', { name: /alpha .*WORKING/i }).click()
    await expect(page.getByRole('heading', { name: 'alpha' })).toBeVisible()
    await expect(page.locator('.cockpit-objective')).toContainText('alpha brief objective')
    await page.locator('.cockpit-objective').click()
    await page.keyboard.press('Control+]')
    await expect(page.getByRole('heading', { name: 'bravo' })).toBeVisible()
    await page.keyboard.press('Control+[')
    await expect(page.getByRole('heading', { name: 'alpha' })).toBeVisible()
    const jump = page.getByRole('textbox', { name: 'Jump to worker' })
    await jump.fill('bravo')
    await jump.press('Control+]')
    await expect(page.getByRole('heading', { name: 'bravo' })).toBeVisible()
    await jump.press('Control+[')
    await expect(page.getByRole('heading', { name: 'alpha' })).toBeVisible()
    const terminalInput = page.frameLocator('iframe[title="alpha terminal"]').frameLocator('#term').getByRole('textbox', { name: 'Terminal input' })
    await expect(terminalInput).toHaveCount(1, { timeout: 15_000 })
    await page.frameLocator('iframe[title="alpha terminal"]').frameLocator('#term').locator('.xterm-screen').click()
    await page.keyboard.type('COCKPIT_PRIVATE_INPUT')
    await expect.poll(() => tmux('capture-pane', '-p', '-t', 'firstmate:fm-alpha')).toContain('COCKPIT_PRIVATE_INPUT')
    await page.keyboard.press('Control+]')
    await expect(page.getByRole('heading', { name: 'bravo' })).toBeVisible()
    await page.keyboard.press('Control+[')
    await expect(page.getByRole('heading', { name: 'alpha' })).toBeVisible()
    await page.getByRole('button', { name: 'Next worker' }).click()
    await expect(page.frameLocator('iframe[title="bravo terminal"]').frameLocator('#term').getByRole('textbox', { name: 'Terminal input' })).toHaveCount(1, { timeout: 15_000 })
    await page.getByRole('button', { name: 'Previous worker' }).click()
    await expect(page.getByRole('heading', { name: 'alpha' })).toBeVisible()
    await page.frameLocator('iframe[title="alpha terminal"]').frameLocator('#term').locator('.xterm-screen').click()
    await page.keyboard.press('Control+]')
    await expect(page.getByRole('heading', { name: 'bravo' })).toBeVisible()
    await page.keyboard.type('COCKPIT_CYCLED_INPUT')
    await expect.poll(() => tmux('capture-pane', '-p', '-t', 'firstmate:fm-bravo')).toContain('COCKPIT_CYCLED_INPUT')
    expect(tmux('capture-pane', '-p', '-t', 'firstmate:fm-alpha')).not.toContain('COCKPIT_CYCLED_INPUT')
    await delay(1200)
    console.log(`private worker window sizes before=${sizesBefore} after attach=${windowSizes()}`)
    expect(windowSizes()).toBe(sizesBefore)
    const frameSizes = await page.locator('.cockpit-terminal-frame').evaluateAll(frames => frames.map(f => {
      const r = f.getBoundingClientRect(); return `${r.width}x${r.height}`
    }))
    const terminalPorts = await Promise.all(['alpha', 'bravo'].map(async id => {
      const response = await fetch(`${base}/api/fleet/cockpit-0-${id}/terminal`).then(r => r.json()) as { data: { port: number } }
      return response.data.port
    }))
    const ttydPid = (p: number) => execFileSync('lsof', ['-nP', '-t', `-iTCP:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim()
    const ttydPids = terminalPorts.map(ttydPid)
    for (let i = 0; i < 10; i++) await page.keyboard.press(i % 2 ? 'Control+[' : 'Control+]')
    await delay(1200)
    const frameSizesAfter = await page.locator('.cockpit-terminal-frame').evaluateAll(frames => frames.map(f => {
      const r = f.getBoundingClientRect(); return `${r.width}x${r.height}`
    }))
    const ttydPidsAfter = terminalPorts.map(ttydPid)
    expect(frameSizesAfter).toEqual(frameSizes)
    expect(ttydPidsAfter).toEqual(ttydPids)
    expect(windowSizes()).toBe(sizesBefore)
    await page.setViewportSize({ width: 1100, height: 900 })
    await delay(1000)
    expect(windowSizes()).toBe(sizesBefore)
    console.log(`private ttyd PIDs before=${ttydPids.join(',')} after=${ttydPidsAfter.join(',')}`)
    console.log(`private iframe sizes before=${frameSizes.join(',')} after=${frameSizesAfter.join(',')}`)
    await page.reload()
    const second = await browser.newPage()
    await second.goto(base)
    await second.getByRole('button', { name: /alpha .*WORKING/i }).click()
    await expect(second.frameLocator('iframe[title="alpha terminal"]').frameLocator('#term').getByRole('textbox', { name: 'Terminal input' })).toHaveCount(1, { timeout: 15_000 })
    const secondFace = second.locator('.cockpit-worker-button').first().locator('.cockpit-face')
    await expect(secondFace.locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml/)
    expect(await secondFace.locator('img').getAttribute('src')).toBe(firstFaceSrc)
    expect(await secondFace.evaluate(el => getComputedStyle(el).borderColor)).toBe(firstFaceColor)
    await page.close()
    expect(windows()).toBe(before)
    expect(windowSizes()).toBe(sizesBefore)
    snapshot(['alpha'])
    appendFileSync(join(home, 'state', 'fleet-ledger.jsonl'), '{}\n')
    await expect(second.locator('.cockpit-worker-button')).toHaveCount(1, { timeout: 30_000 })
    tmux('new-window', '-d', '-t', 'firstmate:', '-n', 'fm-charlie', 'cat')
    snapshot(['alpha', 'charlie'])
    appendFileSync(join(home, 'state', 'fleet-ledger.jsonl'), '{}\n')
    await expect(second.locator('.cockpit-worker-button')).toHaveCount(2, { timeout: 30_000 })
    await expect(second.getByRole('button', { name: /charlie .*WORKING/i })).toBeVisible()
    await second.close()
  } finally {
    server?.kill('SIGTERM')
    try { tmux('kill-server') } catch { /* private server already gone */ }
    rmSync(root, { recursive: true, force: true })
  }
})

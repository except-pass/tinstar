import { test, expect } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')

test('the prompt composer docks under the terminal, sends into the pane, and accepts a dropped file', async ({ page, request }) => {
  test.setTimeout(90_000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-composer-'))
  const home = join(root, 'firstmate')
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const socket = `cockpit-composer-${process.pid}-${Date.now()}`
  const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
  const port = 39000 + Math.floor(Math.random() * 10000)
  const portStart = 50000 + Math.floor(Math.random() * 10000)
  let server: ChildProcess | null = null
  const tmux = (...args: string[]) => execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 10_000 })
  try {
    for (const path of [home, config, bin, join(home, 'bin'), join(home, 'state'), join(home, 'data', 'scribe')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -L '${socket}' -f /dev/null "$@"\n`)
    chmodSync(join(bin, 'tmux'), 0o755)
    writeFileSync(join(bin, 'quota-axi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(config, 'config.json'), JSON.stringify({ firstmate: { homes: [home], ports: { start: portStart, count: 10 } } }))
    writeFileSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), `#!/bin/sh\ncat '${join(home, 'snapshot.json')}'\n`)
    chmodSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), 0o755)
    writeFileSync(join(home, 'data', 'scribe', 'brief.md'), '# Brief\n\n## Captain\'s intent\n\nWrite the note.\n')
    writeFileSync(join(home, 'snapshot.json'), JSON.stringify({
      schema: 'fm-fleet-snapshot.v1',
      tasks: [{
        id: 'scribe', kind: 'worker', project: 'tinstar', branch: 'fm/scribe',
        paths: { worktree: { path: '/tmp/scribe' } },
        current_state: { state: 'idle', detail: 'waiting', observed_at: '2026-09-30T12:00:00Z', freshness: 'fresh' },
        endpoint: { target: 'crew:work', exists: true, agent_alive: 'alive' },
        pr: { url: null },
        backlog: { title: 'Write the note' },
      }],
      backlog: { records: [] },
    }))
    tmux('new-session', '-d', '-s', 'crew', '-n', 'work', 'exec cat')
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TINSTAR_CONFIG_HOME: config, TINSTAR_NO_SESSIONS: '1', TINSTAR_CORS_ORIGINS: `http://127.0.0.1:${port}` }
    delete env.TMUX
    delete env.TMUX_PANE
    server = spawn(join(repo, 'node_modules', '.bin', 'tsx'), ['src/server/standalone.ts', '--port', String(port), '--no-open'], { cwd: repo, env, stdio: 'ignore' })
    const base = `http://127.0.0.1:${port}`
    await expect.poll(async () => {
      if (server?.exitCode !== null) throw new Error(`server exited: ${server?.exitCode}`)
      try { return (await request.get(`${base}/api/fleet`, { timeout: 1000 }).then(response => response.json()) as { data?: { workers?: unknown[] } }).data?.workers?.length ?? 0 }
      catch { return 0 }
    }, { timeout: 15_000 }).toBe(1)

    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(base)
    await page.locator('.cockpit-worker-button', { hasText: 'scribe' }).click()
    const composer = page.getByTestId('prompt-composer')
    const textarea = composer.locator('textarea')
    await expect(textarea).toBeVisible()
    const docked = await page.evaluate(() => {
      const stage = document.querySelector('.cockpit-terminal-stage')!.getBoundingClientRect()
      const box = document.querySelector('[data-testid="prompt-composer"]')!.getBoundingClientRect()
      return Math.abs(stage.bottom - box.top) < 3 && box.bottom > window.innerHeight - 3
    })
    expect(docked).toBe(true)

    await textarea.fill('alpha prompt')
    await textarea.press('Control+Enter')
    await expect(textarea).toHaveValue('')
    await expect.poll(() => tmux('capture-pane', '-p', '-t', 'crew:work')).toContain('alpha prompt')

    await textarea.fill('beta prompt')
    await textarea.press('Control+Enter')
    await expect(textarea).toHaveValue('')
    await page.getByTestId('prompt-history-button').click()
    await expect(page.getByTestId('prompt-history-item-0')).toContainText('beta prompt')
    await expect(page.getByTestId('prompt-history-item-1')).toContainText('alpha prompt')
    await page.keyboard.press('Escape')

    await page.evaluate(() => {
      const target = document.querySelector('[data-testid="prompt-composer"]')!
      const transfer = new DataTransfer()
      transfer.items.add(new File(['hello notes'], 'notes.txt', { type: 'text/plain' }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    })
    await expect(textarea).toHaveValue(/@\S+notes\.txt|@\S+\.txt/)

    const wrapper = page.frameLocator('.cockpit-terminal-frame[data-session]').first()
    const refused = await wrapper.locator('body').evaluate(body => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['stray'], 'stray.txt', { type: 'text/plain' }))
      return ['dragover', 'drop'].map(type => {
        const event = new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer })
        body.dispatchEvent(event)
        return event.defaultPrevented
      })
    })
    expect(refused).toEqual([true, true])
    await expect(composer.locator('[data-testid^="thumb-file-"]')).toContainText('notes.txt')
    await page.screenshot({ path: test.info().outputPath('composer-docked-1440x900.png') })
  } finally {
    if (server && server.exitCode === null) server.kill('SIGTERM')
    try { tmux('kill-server') } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true })
  }
})

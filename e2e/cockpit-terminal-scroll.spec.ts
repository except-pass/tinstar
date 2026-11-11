import { stopServer } from './serverProcess'
import { openWorkerSwitcher } from './shellNavigation'
import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')
const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Lines tmux has painted into the live ttyd screen, not xterm's own scrollback. */
const visibleLines = (page: Page) => page.frames().find(frame => frame.url().includes('/s/cockpit-0-scroll/'))!.evaluate(() => {
  const term = (window as unknown as { term: { rows: number; buffer: { active: { viewportY: number; getLine(y: number): { translateToString(trim: boolean): string } | undefined } } } }).term
  const lines: string[] = []
  for (let i = 0; i < term.rows; i++) lines.push(term.buffer.active.getLine(term.buffer.active.viewportY + i)?.translateToString(true) ?? '')
  return lines.join('\n')
})

test('mouse wheel scrolls the worker terminal to earlier output', async ({ page }) => {
  test.setTimeout(90_000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-scroll-'))
  const home = join(root, 'firstmate')
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const socket = `scroll-${process.pid}-${Date.now()}`
  const port = 39000 + Math.floor(Math.random() * 10000)
  const portStart = 49000 + Math.floor(Math.random() * 10000)
  let server: ChildProcess | null = null
  const terminalInput: string[] = []
  page.on('websocket', socket => {
    if (!socket.url().includes('/s/cockpit-0-scroll/')) return
    socket.on('framesent', ({ payload }) => {
      const message = payload.toString()
      // ttyd's input frames start with the ASCII command byte "0".
      if (message.startsWith('0')) terminalInput.push(message.slice(1))
    })
  })
  const tmux = (...args: string[]) => execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 10_000 }).trim()
  try {
    for (const path of [home, config, bin, join(home, 'bin'), join(home, 'state'), join(home, 'data', 'scroll')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(config, 'config.json'), JSON.stringify({ firstmate: { homes: [home], ports: { start: portStart, count: 20 } } }))
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -L '${socket}' -f /dev/null "$@"\n`)
    chmodSync(join(bin, 'tmux'), 0o755)
    writeFileSync(join(bin, 'quota-axi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    writeFileSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), `#!/bin/sh\ncat '${join(home, 'snapshot.json')}'\n`)
    chmodSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), 0o755)
    writeFileSync(join(home, 'data', 'scroll', 'brief.md'), '# Brief\n\n## Captain\'s intent\n\nScroll the worker terminal.\n')
    writeFileSync(join(home, 'snapshot.json'), JSON.stringify({
      schema: 'fm-fleet-snapshot.v1',
      tasks: [{
        id: 'scroll', kind: 'worker', project: '/private/projects/scroll', branch: 'fm/scroll',
        paths: { worktree: { path: '/private/worktrees/scroll' } },
        current_state: { state: 'working', detail: 'printing history', observed_at: '2026-09-28T12:00:00Z', freshness: 'fresh' },
        endpoint: { target: 'firstmate:fm-scroll' }, pr: { url: null },
      }, {
        id: 'other', kind: 'worker', project: '/private/projects/other', branch: 'fm/other',
        paths: { worktree: { path: '/private/worktrees/other' } },
        current_state: { state: 'working', detail: 'idle', observed_at: '2026-09-28T12:00:00Z', freshness: 'fresh' },
        endpoint: { target: 'firstmate:fm-other' }, pr: { url: null },
      }],
      backlog: { records: [{ id: 'scroll', title: 'scroll objective' }, { id: 'other', title: 'other objective' }] },
    }))
    tmux('new-session', '-d', '-s', 'firstmate', '-x', '80', '-y', '24', '-n', 'supervisor')
    // Leave the top row for tmux's copy-mode status, which overlays narrow terminals.
    tmux('new-window', '-d', '-t', 'firstmate:', '-n', 'fm-scroll',
      'python3 -c \'print("\\nSCROLL-EARLY"); print("\\n".join(f"FILL-{i:03d}" for i in range(1,150))); print("SCROLL-LATE")\'; exec cat')
    tmux('new-window', '-d', '-t', 'firstmate:', '-n', 'fm-other', 'exec cat')

    const env: NodeJS.ProcessEnv = {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, TINSTAR_CONFIG_HOME: config, TINSTAR_STATE_HOME: join(root, 'state'),
      TINSTAR_NO_SESSIONS: '1', TINSTAR_CORS_ORIGINS: `http://127.0.0.1:${port}`,
    }
    delete env.TMUX
    delete env.TMUX_PANE
    server = spawn(process.execPath, ['--import', 'tsx', 'src/server/standalone.ts', '--port', String(port), '--no-open'], {
      cwd: repo, env, stdio: 'ignore',
    })
    const base = `http://127.0.0.1:${port}`
    for (let i = 0; i < 100; i++) {
      try {
        const body = await fetch(`${base}/api/fleet`).then(response => response.json()) as { data?: { workers: unknown[] } }
        if (body.data?.workers.length === 2) break
      } catch { /* starting */ }
      await delay(200)
    }
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto(`${base}/?worker=scroll`)
    await openWorkerSwitcher(page)
    await page.getByRole('button', { name: /scroll .*WORKING/i }).click()
    const term = page.frameLocator('iframe[title="scroll terminal"]').frameLocator('#term')
    const screen = term.locator('.xterm-screen')
    const input = term.getByRole('textbox', { name: 'Terminal input' })
    await expect(screen).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => visibleLines(page), { timeout: 15_000 }).toContain('SCROLL-LATE')
    expect(await visibleLines(page)).not.toContain('SCROLL-EARLY')

    const box = await screen.boundingBox()
    expect(box).toBeTruthy()
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
    for (let i = 0; i < 40 && !(await visibleLines(page)).includes('SCROLL-EARLY'); i++) {
      await page.mouse.wheel(0, -120)
      await delay(40)
    }
    expect(await visibleLines(page)).toContain('SCROLL-EARLY')
    expect(tmux('list-clients', '-F', '#{client_key_table}')).toContain('tsview-scroll')
    expect(tmux('show-options', '-gv', 'mouse')).toBe('off')
    expect(tmux('show-options', '-t', '=firstmate:', 'mouse')).not.toMatch(/mouse on/)

    await input.press('Escape')
    await expect.poll(() => visibleLines(page), { timeout: 8_000 }).toContain('SCROLL-LATE')
    expect(await visibleLines(page)).not.toContain('SCROLL-EARLY')
    await input.pressSequentially('WHEEL_BACK')
    await expect.poll(() => tmux('capture-pane', '-p', '-t', 'firstmate:fm-scroll')).toContain('WHEEL_BACK')
    // Wait for ttyd to paint the input echo before a repaint can clear the selection.
    await expect.poll(() => visibleLines(page)).toContain('WHEEL_BACK')

    // Mouse reporting is on. xterm selects with Shift, or with Option on macOS
    // once macOptionClickForcesSelection is set. A wide drag keeps the selection.
    const live = await screen.boundingBox()
    expect(live).toBeTruthy()
    const modifier = process.platform === 'darwin' ? 'Alt' : 'Shift'
    const y = live!.y + live!.height / 2
    await page.keyboard.down(modifier)
    await page.mouse.move(live!.x + 12, y)
    await page.mouse.down()
    await page.mouse.move(live!.x + Math.min(280, live!.width - 12), y, { steps: 10 })
    await page.mouse.up()
    await page.keyboard.up(modifier)
    const frame = page.frames().find(f => f.url().includes('/s/cockpit-0-scroll/'))!
    await expect.poll(() => frame.evaluate(() => {
      const term = (window as unknown as { term?: { getSelection?: () => string } }).term
      return (term?.getSelection?.() || '').trim().length
    }), { timeout: 3_000 }).toBeGreaterThan(0)

    // An ordinary click must still send both SGR mouse reports to ttyd.
    // In particular, the forced-selection workaround must not swallow release.
    const inputStart = terminalInput.length
    await input.evaluate(element => (element as HTMLElement).blur())
    await page.mouse.click(live!.x + 24, y)
    await expect(input).toBeFocused()
    await expect.poll(() => terminalInput.slice(inputStart).join('')).toMatch(/\x1b\[<0;(\d+);(\d+)M\x1b\[<0;\1;\2m/)
    // Type through the focus established by the click, without locator refocus.
    await page.keyboard.type('PLAIN_CLICK')
    await expect.poll(() => tmux('capture-pane', '-J', '-p', '-t', 'firstmate:fm-scroll')).toContain('PLAIN_CLICK')

    // Switching workers hides this view without detaching it. The pane it
    // scrolled must not stay in copy mode behind it.
    const inMode = () => tmux('display', '-p', '-t', 'firstmate:fm-scroll', '#{pane_in_mode}')
    // tsview-scroll binds Any to "cancel copy mode and drop the key".
    // pane_in_mode flips to 0 before leave() moves the client to
    // tsview-passthrough, and a wheel still in flight puts the client back
    // on the scroll table. Either one eats the first key after the switch.
    const scrollViewTables = () => tmux('list-clients', '-F', '#{session_name} #{client_key_table}')
      .split('\n')
      .filter(line => line.startsWith('tsview-scroll-'))
      .map(line => line.slice(line.lastIndexOf(' ') + 1))
    const scrollLeft = () => {
      const tables = scrollViewTables()
      return inMode() === '0' && tables.length === 1 && tables[0] === 'tsview-passthrough'
    }
    await page.mouse.move(live!.x + live!.width / 2, y)
    for (let i = 0; i < 20 && inMode() !== '1'; i++) {
      await page.mouse.wheel(0, -120)
      await delay(40)
    }
    expect(inMode()).toBe('1')
    let scrollPos = tmux('display', '-p', '-t', 'firstmate:fm-scroll', '#{scroll_position}')
    for (let i = 0; i < 8; i++) {
      await delay(80)
      const next = tmux('display', '-p', '-t', 'firstmate:fm-scroll', '#{scroll_position}')
      if (next === scrollPos) break
      scrollPos = next
    }
    await page.getByRole('button', { name: /other .*WORKING/i }).click()
    await expect.poll(scrollLeft, { timeout: 8_000 }).toBe(true)
    expect(tmux('list-sessions', '-F', '#{session_name}').split('\n').filter(name => name.startsWith('tsview-scroll-'))).toHaveLength(1)

    // Back on the worker, the first key reaches the pane instead of leaving a scroll that is gone.
    await page.getByRole('button', { name: /scroll .*WORKING/i }).click()
    await expect(screen).toBeVisible()
    await expect.poll(scrollLeft, { timeout: 8_000 }).toBe(true)
    await input.pressSequentially('AFTER_SWITCH')
    await expect.poll(() => tmux('capture-pane', '-J', '-p', '-t', 'firstmate:fm-scroll')).toContain('AFTER_SWITCH')
  } finally {
    await stopServer(server)
    try { tmux('kill-server') } catch { /* already gone */ }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
})

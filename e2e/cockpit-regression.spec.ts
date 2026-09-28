import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')
const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const xtermSize = async (page: Page, id: string) => {
  const frame = page.frames().find(f => f.url().includes(`/s/cockpit-0-${id}/`))
  if (!frame) return 'missing'
  return frame.evaluate(() => {
    const term = (window as unknown as { term?: { cols: number; rows: number } }).term
    return term ? `${term.cols}x${term.rows}` : 'missing'
  }).catch(() => 'missing')
}
const leakedSequences = (page: Page, id: string) => page.frames().find(f => f.url().includes(`/s/cockpit-0-${id}/`))!.evaluate(() => {
  const term = (window as unknown as { term: { buffer: { active: { length: number; getLine(y: number): { translateToString(trim: boolean): string } | undefined } } } }).term
  const lines: string[] = []
  for (let y = 0; y < term.buffer.active.length; y++) lines.push(term.buffer.active.getLine(y)?.translateToString(true) ?? '')
  return lines.filter(line => /\uFFFD|\d+;5;\d+m|7337;|\[0m/.test(line))
})
const promptProblems = async (page: Page, id: string) => {
  const problems = await page.evaluate(() => {
    const found: string[] = []
    const stage = document.querySelector('.cockpit-terminal-stage')!.getBoundingClientRect()
    const main = document.querySelector('.cockpit-main')!
    if (stage.bottom > innerHeight || stage.right > innerWidth) found.push(`stage ends at ${stage.right}x${stage.bottom} in ${innerWidth}x${innerHeight}`)
    if (document.documentElement.scrollHeight > innerHeight) found.push('page scrolls')
    if (main.scrollHeight > main.clientHeight) found.push('worker pane scrolls')
    return found
  })
  const wrapper = page.frames().find(f => f.url().includes('terminal-wrapper.html') && f.url().includes(`session=cockpit-0-${id}&`))
  const anchor = await wrapper?.evaluate(() => {
    const term = document.getElementById('term')!
    const r = term.getBoundingClientRect()
    const view = document.documentElement.clientHeight
    return { transformed: !!term.style.transform, left: r.left, bottom: r.bottom, height: r.height, view }
  })
  if (!anchor || anchor.transformed || anchor.left < -1 || anchor.bottom > anchor.view + 1 || anchor.bottom < Math.min(anchor.height, anchor.view) - 1) {
    problems.push(`terminal not full size and anchored to its bottom row: ${JSON.stringify(anchor)}`)
  }
  const bottom = await page.frames().find(f => f.url().includes(`/s/cockpit-0-${id}/`))?.evaluate(() => {
    const term = (window as unknown as { term: { rows: number; buffer: { active: { viewportY: number; getLine(y: number): { translateToString(trim: boolean): string } | undefined } } } }).term
    return term.buffer.active.getLine(term.buffer.active.viewportY + term.rows - 1)?.translateToString(true) ?? ''
  }).catch(() => '')
  if (!bottom?.includes('PROMPT_BOTTOM>')) problems.push(`bottom row is "${bottom}"`)
  return problems
}

test('regression: private First Mate fleet, terminal input, cycling and window survival', async ({ browser }) => {
  test.setTimeout(120_000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-cockpit-'))
  const home = join(root, 'firstmate')
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const socket = `cockpit-${process.pid}-${Date.now()}`
  const operatorSocket = `${socket}-operator`
  const port = 39000 + Math.floor(Math.random() * 10000)
  const portStart = 49000 + Math.floor(Math.random() * 10000)
  let server: ChildProcess | null = null
  const tmux = (...args: string[]) => execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 10_000 }).trim()
  const windows = () => tmux('list-windows', '-t', 'firstmate', '-F', '#{window_id}:#{window_name}')
  const windowSizes = () => tmux('list-windows', '-t', 'firstmate', '-F', '#{window_id}:#{window_width}x#{window_height}')
  const alphaSize = () => tmux('display-message', '-p', '-t', 'firstmate:fm-alpha', '#{window_width}x#{window_height}')
  const operator = (...args: string[]) => execFileSync(realTmux, ['-L', operatorSocket, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 10_000 }).trim()
  const task = (id: string) => ({
    id, kind: 'worker', project: `/private/projects/${id}-service-with-a-realistically-long-name`, branch: `fm/${id}-feature-branch-with-a-long-descriptive-name`,
    paths: { worktree: { path: `/private/worktrees/${id}/nested/checkouts/${id}-service-with-a-realistically-long-name` } },
    current_state: { state: 'working', detail: `${id} active; running the focused test suite after rebasing onto the latest main and waiting for the review gate`, observed_at: '2026-09-28T12:00:00Z', freshness: 'fresh' },
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
      writeFileSync(join(home, 'data', id, 'brief.md'), `# Brief\n\n## Captain's intent\n\n${id} brief objective. ${'Ship the change end to end, keep every worker window safe, and prove it with private screenshots before asking for review. '.repeat(4)}\n\nSecond paragraph with more operator context.\n\n## Firstmate spec\n\nOther text\n`)
    }
    snapshot(['alpha', 'bravo'])
    tmux('new-session', '-d', '-s', 'firstmate', '-x', '220', '-y', '60', '-n', 'supervisor')
    tmux('new-window', '-d', '-t', 'firstmate:', '-n', 'fm-alpha',
      "seq 1 200; printf 'PROMPT_BOTTOM> '; (i=0; while :; do i=$((i+1)); printf '\\033%s\\033[1;1H\\033[38;5;%dm█▓▒░ BUSY ✦ café %s\\033[0m\\033%s' 7 $((i % 256)) \"$i\" 8; sleep 0.05; done) & exec cat")
    // This pane stays idle after printing its prompt, so startup must paint its
    // existing screen without relying on later output to repair the first frame.
    tmux('new-window', '-d', '-t', 'firstmate:', '-n', 'fm-bravo', "seq 1 200; printf 'PROMPT_BOTTOM> '; exec cat")
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
    await expect.poll(() => promptProblems(page, 'bravo')).toEqual([])
    await page.screenshot({ path: test.info().outputPath('private-idle-static-prompt-1280x720.png') })
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
    expect(alphaSize()).toBe('220x60')
    await expect.poll(() => xtermSize(page, 'alpha')).toBe('220x60')
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(viewport)
      await expect.poll(() => promptProblems(page, 'alpha')).toEqual([])
      await page.screenshot({ path: test.info().outputPath(`private-prompt-${viewport.width}x${viewport.height}.png`) })
    }
    await page.setViewportSize({ width: 1280, height: 720 })
    await expect.poll(() => promptProblems(page, 'alpha')).toEqual([])
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
    await page.frames().find(f => f.url().includes('terminal-wrapper.html') && f.url().includes('session=cockpit-0-alpha&'))!
      .evaluate(() => { const el = document.scrollingElement || document.documentElement; el.scrollTop = 0 })
    await page.getByRole('button', { name: /alpha .*WORKING/i }).click()
    await expect.poll(() => promptProblems(page, 'alpha')).toEqual([])
    await page.setViewportSize({ width: 1100, height: 900 })
    await delay(1000)
    expect(windowSizes()).toBe(sizesBefore)
    console.log(`private worker window sizes after viewport resize=${windowSizes()}`)
    expect(await xtermSize(page, 'alpha')).toBe('220x60')
    await page.screenshot({ path: test.info().outputPath('private-prompt-1100x900-after-cycle.png') })
    await expect.poll(() => promptProblems(page, 'alpha')).toEqual([])
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

    const alphaTtyd = () => (fetch(`${base}/api/fleet`).then(r => r.json()) as Promise<{ data: { workers: Array<{ id: string; terminalPid: number | null }> } }>)
      .then(body => body.data.workers.find(w => w.id === 'alpha')?.terminalPid ?? null)
    const crashedTtyd = await alphaTtyd()
    expect(crashedTtyd).not.toBeNull()
    await second.locator('iframe[title="alpha terminal"]').evaluate(frame => { frame.dataset.mounted = 'before-crash' })
    process.kill(crashedTtyd!, 'SIGKILL')
    await expect.poll(alphaTtyd, { timeout: 15_000 }).not.toBe(crashedTtyd)
    await expect.poll(alphaTtyd, { timeout: 15_000 }).not.toBeNull()
    await expect(second.locator('iframe[title="alpha terminal"]')).not.toHaveAttribute('data-mounted', 'before-crash', { timeout: 15_000 })
    await expect.poll(() => promptProblems(second, 'alpha'), { timeout: 15_000 }).toEqual([])
    console.log(`private alpha ttyd recovered in place: ${crashedTtyd} -> ${await alphaTtyd()}`)

    // An operator client resizes the worker, then detaches while the cockpit view
    // is the only client left on the window: the view must not impose its size.
    await expect.poll(() => xtermSize(second, 'alpha')).toBe('220x60')
    await second.locator('iframe[title="alpha terminal"]').evaluate(frame => { frame.dataset.mounted = 'before-operator' })
    tmux('select-window', '-t', 'firstmate:fm-alpha')
    operator('new-session', '-d', '-s', 'operator', '-x', '200', '-y', '50',
      `env -u TMUX '${realTmux}' -L '${socket}' attach-session -t firstmate`)
    await expect.poll(alphaSize).not.toBe('220x60')
    const operatorSize = alphaSize()
    console.log(`private worker alpha size with operator attached=${operatorSize}`)
    await expect.poll(() => xtermSize(second, 'alpha'), { timeout: 3_000 }).toBe(operatorSize)
    await expect(second.locator('iframe[title="alpha terminal"]')).toHaveAttribute('data-mounted', 'before-operator')
    await second.getByRole('button', { name: 'Overview' }).click()
    await second.getByRole('button', { name: /alpha .*WORKING/i }).click()
    await expect.poll(() => xtermSize(second, 'alpha'), { timeout: 5_000 }).toBe(operatorSize)
    await expect.poll(() => promptProblems(second, 'alpha')).toEqual([])
    await delay(5500)
    expect(await leakedSequences(second, 'alpha')).toEqual([])
    await expect.poll(() => promptProblems(second, 'alpha')).toEqual([])
    await delay(1500)
    operator('kill-server')
    await expect.poll(() => tmux('list-clients', '-F', '#{session_name}').split('\n')).not.toContain('firstmate')
    await delay(1500)
    console.log(`private worker alpha size after operator detach=${alphaSize()}`)
    expect(alphaSize()).toBe(operatorSize)
    await expect.poll(() => xtermSize(second, 'alpha'), { timeout: 15_000 }).toBe(operatorSize)
    await second.reload()
    await second.getByRole('button', { name: /alpha .*WORKING/i }).click()
    await expect.poll(() => xtermSize(second, 'alpha'), { timeout: 15_000 }).toBe(operatorSize)
    await expect.poll(() => promptProblems(second, 'alpha')).toEqual([])
    console.log(`private worker alpha size after reconnect=${alphaSize()}`)
    expect(alphaSize()).toBe(operatorSize)
    await second.close()
  } finally {
    server?.kill('SIGTERM')
    try { tmux('kill-server') } catch { /* private server already gone */ }
    try { operator('kill-server') } catch { /* operator server already gone */ }
    rmSync(root, { recursive: true, force: true })
  }
})

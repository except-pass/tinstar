import { test, expect, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')
const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
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
    const rail = document.querySelector('.cockpit-detail-rail')
    if (stage.bottom > innerHeight + 1 || stage.right > innerWidth + 1) found.push(`stage ends at ${stage.right}x${stage.bottom} in ${innerWidth}x${innerHeight}`)
    if (!rail) found.push('detail rail missing')
    else {
      const box = rail.getBoundingClientRect()
      const wide = innerWidth > 1200
      const top = wide ? 0 : box.bottom
      if (Math.abs(stage.top - top) > 2 || stage.bottom < innerHeight - 2) found.push(`terminal does not fill the height below ${Math.round(top)} (${Math.round(stage.top)}..${Math.round(stage.bottom)} of ${innerHeight})`)
      if (wide && (Math.abs(box.left - stage.right) > 2 || box.width < 200)) found.push(`detail rail is not beside the terminal (${Math.round(box.left)} vs stage ${Math.round(stage.right)})`)
      if (!wide) {
        if (box.height > 64 || box.width < stage.width - 2) found.push(`narrow detail rail is not a slim header above the terminal (${Math.round(box.width)}x${Math.round(box.height)})`)
        for (const selector of ['h1', '[aria-label="Previous worker"]', '[aria-label="Next worker"]', '.cockpit-detail-summary']) {
          const r = rail.querySelector(selector)?.getBoundingClientRect()
          if (!r || !r.width || r.bottom > stage.top + 1) found.push(`${selector} is not visible above the terminal`)
        }
        if (!rail.classList.contains('is-open') && rail.querySelector('.cockpit-worker-content')!.getClientRects().length) found.push('narrow detail rail is not collapsed')
      }
    }
    if (document.documentElement.scrollHeight > innerHeight + 1) found.push('page scrolls')
    if (main.scrollHeight > main.clientHeight + 1) found.push('worker pane scrolls')
    return found
  })
  const wrapper = page.frames().find(f => f.url().includes('terminal-wrapper.html') && f.url().includes(`session=cockpit-0-${id}`))
  const anchor = await wrapper?.evaluate(() => {
    const term = document.getElementById('term')!
    const r = term.getBoundingClientRect()
    const view = document.documentElement.clientHeight
    return { transformed: !!term.style.transform, left: r.left, bottom: r.bottom, height: r.height, view }
  })
  if (!anchor || anchor.transformed || anchor.left < -1 || anchor.bottom > anchor.view + 1 || anchor.bottom < Math.min(anchor.height, anchor.view) - 1) {
    problems.push(`terminal not full size and anchored to its bottom row: ${JSON.stringify(anchor)}`)
  }
  const screen = await wrapper?.evaluate(() => {
    const term = document.getElementById('term') as HTMLIFrameElement | null
    const grid = term?.contentDocument?.querySelector('.xterm-screen')
    if (!term || !grid) return null
    const frame = term.getBoundingClientRect()
    const gridBox = grid.getBoundingClientRect()
    return { top: frame.top + gridBox.top, bottom: frame.top + gridBox.bottom }
  })
  const host = await page.locator('.cockpit-terminal-frame').first().boundingBox()
  const viewport = page.viewportSize()
  const screenBottom = host && screen ? host.y + screen.bottom : null
  if (!screen || screenBottom === null || !viewport || screen.top < -1 || screenBottom > viewport.height + 1) {
    problems.push(`terminal screen is outside the stage and viewport (stage top ${screen?.top}, bottom ${screenBottom} of ${viewport?.height})`)
  }
  const bottom = await page.frames().find(f => f.url().includes(`/s/cockpit-0-${id}/`))?.evaluate(() => {
    const term = (window as unknown as { term: { rows: number; buffer: { active: { viewportY: number; getLine(y: number): { translateToString(trim: boolean): string } | undefined } } } }).term
    return term.buffer.active.getLine(term.buffer.active.viewportY + term.rows - 1)?.translateToString(true) ?? ''
  }).catch(() => '')
  if (!bottom?.includes('PROMPT_BOTTOM>')) {
    const visible = await page.frames().find(f => f.url().includes(`/s/cockpit-0-${id}/`))?.evaluate(() => {
      const term = (window as unknown as { term: { rows: number; buffer: { active: { viewportY: number; getLine(y: number): { translateToString(trim: boolean): string } | undefined } } } }).term
      const lines: string[] = []
      for (let i = 0; i < term.rows; i++) lines.push(term.buffer.active.getLine(term.buffer.active.viewportY + i)?.translateToString(true) ?? '')
      return lines.some(line => line.includes('PROMPT_BOTTOM>'))
    }).catch(() => false)
    if (!visible) problems.push(`prompt is not on screen (bottom row is "${bottom}")`)
  }
  return problems
}

/** Font stays 14px, the xterm grid fills the ttyd frame, and tmux matches that grid. */
const fitProblems = async (page: Page, id: string, tmuxSize: string) => {
  const problems: string[] = []
  const wrapper = page.frames().find(f => f.url().includes('terminal-wrapper.html') && f.url().includes(`session=cockpit-0-${id}`))
  const clipped = await wrapper?.evaluate(() => {
    const pageBox = document.scrollingElement || document.documentElement
    const frame = document.getElementById('term')!.getBoundingClientRect()
    return {
      scrollX: pageBox.scrollWidth - pageBox.clientWidth,
      scrollY: pageBox.scrollHeight - pageBox.clientHeight,
      frameRight: frame.right,
      frameBottom: frame.bottom,
      width: pageBox.clientWidth,
      height: pageBox.clientHeight,
    }
  })
  if (!clipped || clipped.scrollX > 1 || clipped.scrollY > 1 || clipped.frameRight > clipped.width + 1 || clipped.frameBottom > clipped.height + 1 || clipped.frameRight < clipped.width - 2 || clipped.frameBottom < clipped.height - 2) {
    problems.push(`wrapper does not fill its stage without scrolling: ${JSON.stringify(clipped)}`)
  }
  const grid = await page.frames().find(f => f.url().includes(`/s/cockpit-0-${id}/`))?.evaluate(() => {
    const term = (window as unknown as { term?: { cols: number; rows: number; options: { fontSize: number | string } } }).term
    const screen = document.querySelector('.xterm-screen')
    const widget = document.querySelector('.xterm')
    const viewport = document.querySelector<HTMLElement>('.xterm-viewport')
    if (!term || !screen || !widget) return null
    const box = screen.getBoundingClientRect()
    const widgetBox = widget.getBoundingClientRect()
    const style = getComputedStyle(widget)
    const pad = (edge: string) => parseFloat(style.getPropertyValue(edge)) || 0
    return {
      fontSize: Number(term.options.fontSize),
      cols: term.cols,
      rows: term.rows,
      left: box.left,
      top: box.top,
      rightGap: window.innerWidth - box.right,
      bottomGap: window.innerHeight - box.bottom,
      widgetLeft: widgetBox.left,
      widgetTop: widgetBox.top,
      widgetRightGap: window.innerWidth - widgetBox.right,
      widgetBottomGap: window.innerHeight - widgetBox.bottom,
      padL: pad('padding-left'),
      padR: pad('padding-right'),
      padT: pad('padding-top'),
      padB: pad('padding-bottom'),
      bar: viewport ? Math.max(0, viewport.offsetWidth - viewport.clientWidth) : 0,
      cellW: box.width / term.cols,
      cellH: box.height / term.rows,
    }
  }).catch(() => null)
  if (!grid) problems.push('xterm grid missing')
  else {
    if (grid.fontSize !== 14) problems.push(`font is ${grid.fontSize}px`)
    const edge = 2
    if (grid.widgetLeft > edge || grid.widgetTop > edge || grid.widgetRightGap > edge || grid.widgetBottomGap > edge || grid.widgetLeft < -1 || grid.widgetTop < -1) {
      problems.push(`terminal widget does not fill the frame (${grid.widgetLeft},${grid.widgetTop} gap ${grid.widgetRightGap.toFixed(1)}x${grid.widgetBottomGap.toFixed(1)})`)
    }
    if (grid.left < -1 || grid.left > grid.padL + edge || grid.top < -1 || grid.top > grid.padT + edge) problems.push(`grid starts at ${grid.left},${grid.top}`)
    // ttyd pads the widget. xterm also reserves a scrollback gutter; on overlay
    // scrollbars that gutter is not in clientWidth, so allow a normal bar width.
    const slack = 4
    const gutter = Math.max(grid.bar, 16)
    const rightBudget = grid.padR + gutter + grid.cellW + slack
    const bottomBudget = grid.padB + grid.cellH + slack
    if (grid.rightGap < -1 || grid.rightGap > rightBudget) problems.push(`horizontal gap ${grid.rightGap.toFixed(1)}px (budget ${rightBudget.toFixed(1)} pad ${grid.padL}+${grid.padR} bar ${grid.bar} cell ${grid.cellW.toFixed(2)} left ${grid.left.toFixed(1)} widgetRight ${grid.widgetRightGap.toFixed(1)})`)
    if (grid.bottomGap < -1 || grid.bottomGap > bottomBudget) problems.push(`vertical gap ${grid.bottomGap.toFixed(1)}px (budget ${bottomBudget.toFixed(1)} pad ${grid.padT}+${grid.padB} cell ${grid.cellH.toFixed(2)} top ${grid.top.toFixed(1)} widgetBottom ${grid.widgetBottomGap.toFixed(1)})`)
    const seen = `${grid.cols}x${grid.rows}`
    if (seen !== tmuxSize) problems.push(`tmux ${tmuxSize} xterm ${seen}`)
  }
  return problems
}

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
  const alphaSize = () => tmux('display-message', '-p', '-t', 'firstmate:fm-alpha', '#{window_width}x#{window_height}')
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
    writeFileSync(join(bin, 'quota-axi'), `#!/bin/sh\ncat <<'END_QUOTA'\n${readFileSync(join(repo, 'src/server/quota/__tests__/recorded-quota-axi.json'), 'utf8')}\nEND_QUOTA\n`)
    chmodSync(join(bin, 'quota-axi'), 0o755)
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
    await page.getByRole('button', { name: 'Workers' }).click()
    await expect(page.locator('.cockpit-worker-button')).toHaveCount(2)
    await expect(page.getByRole('button', { name: 'Claude, 64% remaining' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('private-quota-populated-1280x720.png') })
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
    await expect(page.locator('.cockpit-objective')).toHaveCount(1)
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
    for (const viewport of [
      { width: 1280, height: 720 }, { width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1440, height: 700 }, { width: 1920, height: 1080 },
      { width: 1000, height: 1080 }, { width: 1000, height: 900 }, { width: 1000, height: 768 }, { width: 1000, height: 720 }, { width: 1000, height: 700 }, { width: 720, height: 900 },
    ]) {
      await page.setViewportSize(viewport)
      await expect.poll(() => promptProblems(page, 'alpha')).toEqual([])
      await expect.poll(() => fitProblems(page, 'alpha', alphaSize())).toEqual([])
      await page.screenshot({ path: test.info().outputPath(`private-prompt-${viewport.width}x${viewport.height}.png`) })
    }
    await page.setViewportSize({ width: 720, height: 900 })
    await page.locator('.cockpit-detail-summary').click()
    await expect(page.locator('.cockpit-objective')).toBeVisible()
    await expect(page.locator('.cockpit-status-detail')).toBeVisible()
    await expect.poll(() => promptProblems(page, 'alpha')).toEqual([])
    await expect.poll(() => fitProblems(page, 'alpha', alphaSize())).toEqual([])
    await page.screenshot({ path: test.info().outputPath('private-prompt-720x900-details-open.png') })
    await page.locator('.cockpit-detail-summary').click()
    await page.setViewportSize({ width: 1280, height: 720 })
    await expect.poll(() => promptProblems(page, 'alpha')).toEqual([])
    await expect.poll(() => fitProblems(page, 'alpha', alphaSize())).toEqual([])
    expect(await leakedSequences(page, 'alpha')).toEqual([])
    const fittedSizes = windowSizes()
    console.log(`private worker window sizes before=${sizesBefore} fitted=${fittedSizes}`)
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
    expect(windowSizes()).toBe(fittedSizes)
    const frameSizes = await page.locator('.cockpit-terminal-frame').evaluateAll(frames => frames.map(f => {
      const r = f.getBoundingClientRect(); return `${r.width}x${r.height}`
    }))
    const terminalPorts = await Promise.all(['alpha', 'bravo'].map(async id => {
      const response = await fetch(`${base}/api/fleet/cockpit-0-${id}/terminal`).then(r => r.json()) as { data: { port: number } }
      return response.data.port
    }))
    const ttydPid = (p: number) => execFileSync('lsof', ['-nP', '-t', `-iTCP:${p}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim()
    const ttydPids = terminalPorts.map(ttydPid)
    for (let i = 0; i < 20; i++) await page.keyboard.press(i % 2 ? 'Control+[' : 'Control+]')
    await expect(page.getByRole('heading', { name: 'bravo' })).toBeVisible()
    expect(await page.locator('.cockpit-switch-flash').evaluate(el => el.getAnimations().length)).toBeLessThanOrEqual(1)
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.keyboard.press('Control+]')
    await expect(page.getByRole('heading', { name: 'alpha' })).toBeVisible()
    expect(await page.locator('.cockpit-switch-flash').evaluate(el => getComputedStyle(el).animationName)).toBe('none')
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.keyboard.press('Control+[')
    await expect(page.getByRole('heading', { name: 'bravo' })).toBeVisible()
    const videoDir = test.info().outputPath('motion-video')
    mkdirSync(videoDir, { recursive: true })
    const motionContext = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: videoDir } })
    try {
      const motionPage = await motionContext.newPage()
      const video = motionPage.video()
      await motionPage.goto(base)
      await motionPage.getByRole('button', { name: 'Workers' }).click()
      await motionPage.getByRole('button', { name: /alpha .*WORKING/i }).click()
      await expect(motionPage.getByRole('heading', { name: 'alpha' })).toBeVisible()
      for (let i = 0; i < 20; i++) await motionPage.keyboard.press(i % 2 ? 'Control+[' : 'Control+]')
      await expect(motionPage.getByRole('heading', { name: 'alpha' })).toBeVisible()
      await motionPage.close()
      await video?.saveAs(test.info().outputPath('private-20-switches.webm'))
    } finally {
      await motionContext.close()
    }
    await delay(1200)
    const frameSizesAfter = await page.locator('.cockpit-terminal-frame').evaluateAll(frames => frames.map(f => {
      const r = f.getBoundingClientRect(); return `${r.width}x${r.height}`
    }))
    const ttydPidsAfter = terminalPorts.map(ttydPid)
    expect(frameSizesAfter).toEqual(frameSizes)
    expect(ttydPidsAfter).toEqual(ttydPids)
    expect(windowSizes()).toBe(fittedSizes)
    const sizeAt1280 = alphaSize()
    await page.setViewportSize({ width: 1100, height: 900 })
    await expect.poll(() => alphaSize()).not.toBe(sizeAt1280)
    await expect.poll(() => fitProblems(page, 'alpha', alphaSize())).toEqual([])
    console.log(`private worker window sizes after viewport resize=${windowSizes()}`)
    await page.screenshot({ path: test.info().outputPath('private-prompt-1100x900-after-cycle.png') })
    await expect.poll(() => promptProblems(page, 'alpha')).toEqual([])
    console.log(`private ttyd PIDs before=${ttydPids.join(',')} after=${ttydPidsAfter.join(',')}`)
    console.log(`private iframe sizes before=${frameSizes.join(',')} after=${frameSizesAfter.join(',')}`)
    await page.reload()
    const second = await browser.newPage()
    await second.goto(base)
    await second.getByRole('button', { name: 'Workers' }).click()
    await second.getByRole('button', { name: /alpha .*WORKING/i }).click()
    await expect(second.frameLocator('iframe[title="alpha terminal"]').frameLocator('#term').getByRole('textbox', { name: 'Terminal input' })).toHaveCount(1, { timeout: 15_000 })
    const secondFace = second.locator('.cockpit-worker-button').first().locator('.cockpit-face')
    await expect(secondFace.locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml/)
    expect(await secondFace.locator('img').getAttribute('src')).toBe(firstFaceSrc)
    expect(await secondFace.evaluate(el => getComputedStyle(el).borderColor)).toBe(firstFaceColor)
    await page.close()
    expect(windows()).toBe(before)
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
    await expect.poll(() => fitProblems(second, 'alpha', alphaSize()), { timeout: 15_000 }).toEqual([])
    console.log(`private alpha ttyd recovered in place: ${crashedTtyd} -> ${await alphaTtyd()}`)
    await second.close()
  } finally {
    server?.kill('SIGTERM')
    try { tmux('kill-server') } catch { /* private server already gone */ }
    rmSync(root, { recursive: true, force: true })
  }
})

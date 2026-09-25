import { expect, test, type Page } from '@playwright/test'

/**
 * Opt-in. The default e2e harness binds 5290 and this file must not join it.
 * The T24 run starts Vite on its own port and sets T24_BASE_URL.
 */
const baseURL = process.env.T24_BASE_URL

test.skip(!baseURL, 'T24_BASE_URL points at the isolated server for this run')
test.use({ baseURL })

const workers = ['alpha', 'beta', 'gamma'].map(id => ({
  source: 'fm-fleet-snapshot',
  fixture: true,
  id,
  spawnGen: '1',
  project: 'tinstar',
  worktree: { path: `/tmp/${id}`, present: true },
  backend: 'tmux',
  endpoint: { target: `sess:${id}`, exists: true, agentAlive: 'alive', status: 'alive' },
  crewState: 'working',
  observedAt: '2026-09-24T04:00:00Z',
}))

async function installApi(page: Page, terminal: 'live' | 'down') {
  await page.route('**/api/**', async route => {
    const url = route.request().url()
    if (url.includes('/api/v6/workers') && url.includes('/terminal')) {
      const data = terminal === 'live'
        ? { state: 'live' }
        : { state: 'unavailable', reason: 'endpoint changed' }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, data }),
      })
      return
    }
    if (url.includes('/api/v6/workers')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          data: { configured: true, workers, identities: {}, diagnostics: [] },
        }),
      })
      return
    }
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: { message: 'not in this test' } }),
    })
  })
}

async function openShell(page: Page, terminal: 'live' | 'down' = 'live') {
  await installApi(page, terminal)
  await page.goto('/?v6=1')
  await expect(page.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'alpha')
  await expect(page.getByTestId('worker-gamma')).toBeVisible()
}

test('jumps and rapid switches commit before the arrival animation ends', async ({ page }) => {
  await openShell(page)
  const jump = await page.evaluate(() => new Promise<{ view: string; seen: string[]; elapsed: number }>(resolve => {
    const shell = document.querySelector('[data-testid="v6-shell"]')!
    const seen: string[] = []
    const obs = new MutationObserver(() => { seen.push(shell.getAttribute('data-view') ?? '') })
    obs.observe(shell, { attributes: true, attributeFilter: ['data-view'] })
    const start = performance.now()
    ;(document.querySelector('[data-testid="board"]') as HTMLButtonElement).click()
    requestAnimationFrame(() => {
      const elapsed = performance.now() - start
      obs.disconnect()
      resolve({ view: shell.getAttribute('data-view') ?? '', seen, elapsed })
    })
  }))
  expect(jump.elapsed).toBeLessThan(160)
  expect(jump.view).toBe('portfolio')
  expect(jump.seen.every(view => view === 'portfolio')).toBe(true)
  expect(jump.seen).not.toContain('epic')
  expect(jump.seen).not.toContain('task')

  await page.getByTestId('worker-alpha').click()
  await expect(page.getByTestId('v6-shell')).toHaveAttribute('data-view', 'worker')

  const burst = await page.evaluate(() => new Promise<{
    worker: string
    seq: string
    ended: number
    elapsed: number
    steps: string[]
  }>(resolve => {
    const shell = document.querySelector('[data-testid="v6-shell"]')!
    const stage = document.querySelector('[data-testid="v6-stage"]')!
    let ended = 0
    stage.addEventListener('animationend', () => { ended += 1 })
    const steps: string[] = []
    const start = performance.now()
    for (let i = 0; i < 6; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        code: 'BracketRight',
        key: ']',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }))
      steps.push(shell.getAttribute('data-worker') ?? '')
    }
    const elapsed = performance.now() - start
    requestAnimationFrame(() => {
      resolve({
        worker: shell.getAttribute('data-worker') ?? '',
        seq: shell.getAttribute('data-switch-seq') ?? '',
        ended,
        elapsed,
        steps,
      })
    })
  }))
  expect(burst.elapsed).toBeLessThan(160)
  expect(burst.ended).toBe(0)
  expect(burst.seq).toBe('8')
  expect(burst.worker).toBe('alpha')
  expect(burst.steps).toHaveLength(6)
})

test('reduced motion removes the arrival animation and still cycles', async ({ browser }) => {
  const context = await browser.newContext({ baseURL, reducedMotion: 'reduce' })
  const page = await context.newPage()
  try {
    await openShell(page)
    await expect(page.getByTestId('v6-shell')).toHaveAttribute('data-reduced', 'true')
    const motion = await page.getByTestId('v6-stage').evaluate(element => {
      const style = getComputedStyle(element)
      return { name: style.animationName, duration: style.animationDuration }
    })
    expect(motion.name).toBe('none')
    const row = await page.getByTestId('worker-alpha').evaluate(element => getComputedStyle(element).transitionDuration)
    expect(row === '0s' || row.split(',').every(part => part.trim() === '0s')).toBe(true)
    await page.keyboard.press('Control+BracketRight')
    await expect(page.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')
    expect(await page.getByTestId('v6-stage').evaluate(element => element.classList.contains('v6-arrive'))).toBe(false)
  } finally {
    await context.close()
  }
})

test('focus returns after the dialog, a view change, and the terminal', async ({ page }) => {
  await openShell(page, 'down')
  const opener = page.getByTestId('open-terminal')
  await opener.click()
  const dialog = page.getByTestId('v6-terminal-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(opener).toBeFocused()
  await page.keyboard.press('Control+BracketRight')
  await expect(page.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')
  await expect(page.getByTestId('v6-shell')).toHaveAttribute('data-view', 'worker')

  await page.getByLabel('Message').focus()
  await page.getByTestId('board').click()
  await expect(page.getByTestId('v6-shell')).toHaveAttribute('data-view', 'portfolio')
  await expect(page.getByTestId('board')).toBeFocused()
  await page.keyboard.press('Control+BracketRight')
  await expect(page.getByTestId('v6-shell')).toHaveAttribute('data-view', 'worker')
  await expect(page.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'gamma')
})

test('terminal bracket keys cycle and closing the view restores focus', async ({ page }) => {
  await openShell(page, 'live')
  await page.getByTestId('open-terminal').click()
  const frame = page.getByTestId('terminal-alpha')
  await expect(frame).toBeVisible()
  await expect.poll(() => frame.evaluate(element => (element as HTMLIFrameElement).contentDocument?.readyState ?? 'no')).toBe('complete')
  await frame.evaluate(element => {
    const child = (element as HTMLIFrameElement).contentWindow
    child?.focus()
    child?.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'BracketRight',
      key: ']',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }))
  })
  await expect(page.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')
  await expect(page.getByTestId('open-terminal')).toBeFocused()

  await page.getByTestId('open-terminal').click()
  await expect(page.getByTestId('terminal-beta')).toBeVisible()
  await page.getByRole('button', { name: 'Close view' }).click()
  await expect(page.getByTestId('terminal-beta')).toHaveCount(0)
  await expect(page.getByTestId('open-terminal')).toBeFocused()
  await page.keyboard.press('Control+BracketLeft')
  await expect(page.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'alpha')
})

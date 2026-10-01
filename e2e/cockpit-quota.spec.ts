import { test, expect } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')

test('quota rail shows a weekly calendar strip and a hover detail', async ({ page, request }) => {
  test.setTimeout(60_000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-quota-'))
  const home = join(root, 'firstmate')
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const port = 39000 + Math.floor(Math.random() * 10000)
  let server: ChildProcess | null = null
  try {
    for (const path of [home, config, bin, join(home, 'bin'), join(home, 'state')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(config, 'config.json'), JSON.stringify({ firstmate: { homes: [home] } }))
    writeFileSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), `#!/bin/sh\ncat '${join(home, 'snapshot.json')}'\n`)
    chmodSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), 0o755)
    writeFileSync(join(home, 'snapshot.json'), JSON.stringify({
      schema: 'fm-fleet-snapshot.v1',
      tasks: [{
        id: 'alpha', kind: 'ship', project: 'tinstar', branch: 'fm/alpha',
        paths: { worktree: { path: '/private/worktrees/alpha' } },
        current_state: { state: 'working', detail: 'editing the quota rail', observed_at: '2026-09-29T12:00:00Z', freshness: 'fresh' },
        endpoint: { target: null }, pr: { url: null },
        backlog: { title: 'Show provider quota' },
      }],
      backlog: { records: [{ id: 'alpha', title: 'Show provider quota' }] },
    }))
    writeFileSync(join(bin, 'quota-axi'), `#!/bin/sh\ncat <<'END_QUOTA'\n${readFileSync(join(repo, 'src/server/quota/__tests__/recorded-quota-axi.json'), 'utf8')}\nEND_QUOTA\n`)
    chmodSync(join(bin, 'quota-axi'), 0o755)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TINSTAR_CONFIG_HOME: config,
      TINSTAR_NO_SESSIONS: '1',
      TINSTAR_CORS_ORIGINS: `http://127.0.0.1:${port}`,
    }
    delete env.TMUX
    delete env.TMUX_PANE
    server = spawn(join(repo, 'node_modules', '.bin', 'tsx'), ['src/server/standalone.ts', '--port', String(port), '--no-open'], {
      cwd: repo, env, stdio: 'ignore',
    })
    const base = `http://127.0.0.1:${port}`
    await expect.poll(async () => {
      if (server?.exitCode !== null) throw new Error(`server exited: ${server?.exitCode}`)
      try {
        const body = await request.get(`${base}/api/quota`, { timeout: 1000 }).then(response => response.json()) as { providers?: unknown[] }
        return body.providers?.length ?? 0
      } catch { return 0 }
    }, { timeout: 20_000 }).toBe(5)

    await page.clock.setFixedTime(new Date('2026-09-29T12:00:00.000Z'))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(base)
    const rail = page.getByRole('region', { name: 'Provider quota' })
    await expect(rail.getByRole('button', { name: 'Claude, 64% remaining' })).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Codex, 18% remaining' })).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Grok, no reading' })).toBeVisible()
    await expect(rail.getByRole('button', { name: 'Kimi, 3% remaining' })).toBeVisible()
    await expect(rail.getByText('5h 82')).toBeVisible()
    const unsignedCursor = rail.getByRole('button', { name: 'Cursor, not signed in' })
    await expect(unsignedCursor).toBeVisible()
    await expect(unsignedCursor.getByText('Sign in', { exact: true })).toBeVisible()
    const badges = page.getByLabel('Quota summary').getByRole('button')
    await expect(badges).toHaveCount(4)
    await expect(page.getByRole('button', { name: /^Cursor summary/ })).toHaveCount(0)
    const layout = await rail.evaluate(element => {
      const box = element.getBoundingClientRect()
      const strips = Array.from(element.querySelectorAll('.cockpit-quota-meter.is-week'))
      const compact = Array.from(element.querySelectorAll('.cockpit-quota-compact .cockpit-quota-meter'))
      const tops = compact.map(meter => meter.getBoundingClientRect().top)
      return {
        strips: strips.length,
        playheads: element.querySelectorAll('[data-testid="bar-playhead"]').length,
        days: element.querySelectorAll('[data-testid="weekday-label"]').length,
        overflow: strips.some(strip => {
          const stripBox = strip.getBoundingClientRect()
          return stripBox.left < box.left - 1 || stripBox.right > box.right + 1
        }),
        compactSpread: tops.length ? Math.max(...tops) - Math.min(...tops) : 0,
      }
    })
    expect(layout.strips).toBe(2)
    expect(layout.playheads).toBe(2)
    expect(layout.days).toBe(14)
    expect(layout.overflow).toBe(false)
    expect(layout.compactSpread).toBeLessThan(4)
    expect((await rail.evaluate(element => element.textContent ?? '')).toLowerCase()).not.toContain('unavailable')
    await page.screenshot({ path: test.info().outputPath('quota-rail-1440x900.png') })

    const claude = rail.getByRole('button', { name: 'Claude, 64% remaining' })
    await claude.hover()
    const claudeTip = claude.getByRole('tooltip')
    await expect(claudeTip).toBeVisible()
    await expect(claudeTip).toContainText('64%')
    await expect(claudeTip).toContainText('week')
    await expect(claudeTip).toContainText('pro')
    await expect(claudeTip).toContainText('Refreshed')
    expect(await claudeTip.evaluate(element => element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0)
    await page.screenshot({ path: test.info().outputPath('quota-hover-1440x900.png') })

    for (const name of ['Codex, 18% remaining', 'Kimi, 3% remaining']) {
      const meter = rail.getByRole('button', { name })
      await meter.hover()
      const tip = meter.getByRole('tooltip')
      await expect(tip).toBeVisible()
      const box = await tip.evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect)
      expect(box.left).toBeGreaterThanOrEqual(0)
      expect(box.right).toBeLessThanOrEqual(1440)
    }
    await expect(rail.getByRole('button', { name: 'Kimi, 3% remaining' }).getByRole('tooltip')).toContainText('stale reading')

    await page.mouse.move(0, 0)
    const grok = rail.getByRole('button', { name: 'Grok, no reading' })
    await grok.focus()
    await expect(grok.getByRole('tooltip')).toContainText('usage endpoint rejected the session')
    await page.screenshot({ path: test.info().outputPath('quota-focus-1440x900.png') })
    await claude.hover()
    await expect(claudeTip).toBeVisible()
    await expect(grok.getByRole('tooltip')).toBeHidden()
    await unsignedCursor.hover()
    await expect(unsignedCursor.getByRole('tooltip')).toContainText('Not signed in. Sign in to Cursor to show quota.')
    await page.screenshot({ path: test.info().outputPath('quota-cursor-signin-1440x900.png') })

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(rail.getByRole('button', { name: 'Claude, 64% remaining' })).toBeVisible()
    const phone = await rail.evaluate(element => {
      const box = element.getBoundingClientRect()
      const strips = Array.from(element.querySelectorAll('.cockpit-quota-meter.is-week'))
      return {
        strips: strips.length,
        overflow: strips.some(strip => {
          const stripBox = strip.getBoundingClientRect()
          return stripBox.left < box.left - 1 || stripBox.right > box.right + 1
        }),
      }
    })
    expect(phone.strips).toBe(2)
    expect(phone.overflow).toBe(false)
    const lastMeter = rail.getByRole('button', { name: 'Kimi, 3% remaining' })
    await lastMeter.hover()
    const phoneTip = await lastMeter.getByRole('tooltip').evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect)
    expect(phoneTip.left >= 0 && phoneTip.right <= 390 && phoneTip.top >= 0).toBe(true)
    await page.screenshot({ path: test.info().outputPath('quota-rail-390x844.png') })
  } finally {
    server?.kill('SIGTERM')
    rmSync(root, { recursive: true, force: true })
  }
})


test('quota rail draws a signed-in Cursor against its usage cycle', async ({ page, request }) => {
  test.setTimeout(60_000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-quota-cursor-'))
  const home = join(root, 'firstmate')
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const port = 39000 + Math.floor(Math.random() * 10000)
  let server: ChildProcess | null = null
  const recorded = JSON.parse(readFileSync(join(repo, 'src/server/quota/__tests__/recorded-quota-axi.json'), 'utf8')) as { providers: Array<{ provider: string }> }
  const cycle = { kind: 'monthly', startsAt: '2026-09-24T12:00:00.000Z', resetsAt: '2026-10-24T12:00:00.000Z' }
  const document = { ...recorded, providers: recorded.providers.map(provider => provider.provider !== 'cursor' ? provider : {
    provider: 'cursor', label: 'Cursor', plan: 'Pro',
    windows: [
      { id: 'included_usage', label: 'included usage', percentRemaining: 40, ...cycle },
      { id: 'auto_usage', label: 'auto usage', percentRemaining: 90, ...cycle },
      { id: 'grok_bot', label: 'Grok Bot', kind: 'weekly', percentRemaining: 5, startsAt: '2026-09-28T00:00:00.000Z' },
    ],
    state: { status: 'fresh', stale: false, refreshedAt: '2026-09-29T11:59:00.000Z' },
    quotaSemantics: { status: 'known', effectiveAvailability: [
      { scope: 'all_models', status: 'known', effectivePercentRemaining: 40, boundedBy: ['included_usage', 'auto_usage'], limitingWindowIds: ['included_usage'] },
      { scope: 'grok_bot', status: 'known', effectivePercentRemaining: 5, boundedBy: ['grok_bot'], limitingWindowIds: ['grok_bot'] },
    ] },
  }) }
  try {
    for (const path of [home, config, bin, join(home, 'bin'), join(home, 'state')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(config, 'config.json'), JSON.stringify({ firstmate: { homes: [home] } }))
    writeFileSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), `#!/bin/sh\ncat '${join(home, 'snapshot.json')}'\n`)
    chmodSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), 0o755)
    writeFileSync(join(home, 'snapshot.json'), JSON.stringify({ schema: 'fm-fleet-snapshot.v1', tasks: [], backlog: { records: [] } }))
    writeFileSync(join(bin, 'quota-axi'), `#!/bin/sh\ncat <<'END_QUOTA'\n${JSON.stringify(document)}\nEND_QUOTA\n`)
    chmodSync(join(bin, 'quota-axi'), 0o755)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      TINSTAR_CONFIG_HOME: config,
      TINSTAR_NO_SESSIONS: '1',
      TINSTAR_CORS_ORIGINS: `http://127.0.0.1:${port}`,
    }
    delete env.TMUX
    delete env.TMUX_PANE
    server = spawn(join(repo, 'node_modules', '.bin', 'tsx'), ['src/server/standalone.ts', '--port', String(port), '--no-open'], {
      cwd: repo, env, stdio: 'ignore',
    })
    const base = `http://127.0.0.1:${port}`
    await expect.poll(async () => {
      if (server?.exitCode !== null) throw new Error(`server exited: ${server?.exitCode}`)
      try {
        const body = await request.get(`${base}/api/quota`, { timeout: 1000 }).then(response => response.json()) as { providers?: unknown[] }
        return body.providers?.length ?? 0
      } catch { return 0 }
    }, { timeout: 20_000 }).toBe(5)

    await page.clock.setFixedTime(new Date('2026-09-29T12:00:00.000Z'))
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(base)
    const rail = page.getByRole('region', { name: 'Provider quota' })
    // The Grok Bot week (5%) is an independent resource; the meter reports the all-models cycle.
    const cursor = rail.getByRole('button', { name: 'Cursor, 40% remaining' })
    await expect(cursor).toBeVisible()
    await expect(cursor.getByText('Oct 24', { exact: true })).toBeVisible()
    await expect(cursor.locator('img')).toHaveAttribute('src', '/agent-icons/cursor.svg')
    await expect(rail.getByRole('button', { name: 'Claude, 64% remaining' })).toBeVisible()
    const shape = await cursor.evaluate(element => {
      const race = element.querySelector('.cockpit-quota-race')
      const rail = element.closest('[aria-label="Provider quota"]')!.getBoundingClientRect()
      const box = element.getBoundingClientRect()
      return {
        days: element.querySelectorAll('[data-testid="weekday-label"]').length,
        playhead: race?.querySelector('line')?.getAttribute('x1'),
        overflow: box.left < rail.left - 1 || box.right > rail.right + 1,
      }
    })
    expect(shape.days).toBe(0)
    expect(Number(shape.playhead)).toBeCloseTo(30, 0)
    expect(shape.overflow).toBe(false)
    await expect(page.getByLabel('Quota summary').getByRole('button')).toHaveCount(4)
    await page.screenshot({ path: test.info().outputPath('quota-cursor-cycle-1440x900.png') })

    await cursor.hover()
    const tip = cursor.getByRole('tooltip')
    await expect(tip).toBeVisible()
    await expect(tip).toContainText('40%')
    await expect(tip).toContainText('included usage')
    await expect(tip).toContainText('Pro')
    await expect(tip).not.toContainText('Grok Bot')
    await page.screenshot({ path: test.info().outputPath('quota-cursor-hover-1440x900.png') })
  } finally {
    server?.kill('SIGTERM')
    rmSync(root, { recursive: true, force: true })
  }
})

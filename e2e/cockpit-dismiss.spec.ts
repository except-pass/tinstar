import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')

async function slide(page: Page, slider: Locator, fraction: number) {
  await slider.scrollIntoViewIfNeeded()
  const box = await slider.boundingBox()
  const knob = slider.locator('.cockpit-slide-knob')
  const knobBox = await knob.boundingBox()
  if (!box || !knobBox) throw new Error('slide control has no box')
  const travel = box.width - knobBox.width - 4
  const y = knobBox.y + knobBox.height / 2
  await page.mouse.move(knobBox.x + knobBox.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(box.x + 2 + knobBox.width / 2 + travel * fraction, y, { steps: 15 })
  await page.mouse.up()
}

async function startCockpit(request: APIRequestContext, names: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'tinstar-dismiss-'))
  const homes = names.map(name => join(root, name))
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const socket = `cockpit-dismiss-${process.pid}-${Date.now()}`
  const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
  const port = 39000 + Math.floor(Math.random() * 10000)
  let server: ChildProcess | null = null
  const notes = (home = homes[0]!) => readdirSync(join(home, 'state')).filter(name => name.startsWith('tinstar-') && name.endsWith('.json'))
  const snapshot = (open: boolean, home = homes[0]!) => writeFileSync(join(home, 'snapshot.json'), JSON.stringify({
    schema: 'fm-fleet-snapshot.v1',
    tasks: [{ id: 'alpha', kind: 'worker', project: 'private-project', branch: 'fm/alpha',
      paths: { worktree: { path: '/private/worktrees/alpha' } }, current_state: { state: 'paused', detail: 'Waiting for a decision', freshness: 'fresh' },
      endpoint: { target: null }, hints: { open_decisions: open ? [{ key: 'choice', verb: 'needs-decision', summary: 'Choose the rollout order' }] : [] } }],
    backlog: { records: open ? [{ id: 'alpha-decision-choice', state: 'held', hold_kind: 'captain', hold_reason: 'Choose the rollout order', title: 'Rollout order', hold_age_days: 2 }] : [] },
  }))
  const stop = () => {
    server?.kill('SIGTERM')
    try { execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', 'kill-server']) } catch { /* private server absent */ }
    rmSync(root, { recursive: true, force: true })
  }
  try {
    for (const path of [config, bin]) mkdirSync(path, { recursive: true })
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -L '${socket}' -f /dev/null "$@"\n`)
    chmodSync(join(bin, 'tmux'), 0o755)
    writeFileSync(join(config, 'config.json'), JSON.stringify({ firstmate: { homes } }))
    for (const home of homes) {
      for (const path of [join(home, 'bin'), join(home, 'state'), join(home, 'data', 'alpha')]) mkdirSync(path, { recursive: true })
      writeFileSync(join(home, 'data', 'alpha', 'brief.md'), '# Brief\n\n## Captain\'s intent\n\nShip the smaller group first.\n')
      writeFileSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), `#!/bin/sh\ncat '${join(home, 'snapshot.json')}'\n`)
      chmodSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), 0o755)
      const inbox = join(home, 'bin', 'fm-inbox.sh')
      writeFileSync(inbox, `#!/usr/bin/env python3
import json, pathlib, sys
state = pathlib.Path(__file__).resolve().parent.parent / 'state'
command = sys.argv[1]
if command == 'note':
    request_id = sys.argv[sys.argv.index('--request-id') + 1]
    path = state / (request_id + '.json')
    if not path.exists(): path.write_text(json.dumps({'request_id': request_id, 'body': sys.stdin.read()}))
    print(json.dumps({'schema': 'fm-inbox-note.v1', 'saved': True, 'id': request_id}))
elif command == 'receipts':
    rows = []
    for path in state.glob('tinstar-*.json'):
        row = json.loads(path.read_text())
        row['acknowledged'] = False
        row.setdefault('reply', None)
        rows.append(row)
    print(json.dumps({'schema': 'fm-inbox-receipts.v1', 'pending': rows, 'handled': []}))
elif command == 'ready':
    print(json.dumps({'can_receive': True}))
`)
      chmodSync(inbox, 0o755)
      snapshot(true, home)
    }
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TINSTAR_CONFIG_HOME: config, TINSTAR_NO_SESSIONS: '1', TINSTAR_CORS_ORIGINS: `http://127.0.0.1:${port}` }
    delete env.TMUX
    delete env.TMUX_PANE
    server = spawn(join(repo, 'node_modules', '.bin', 'tsx'), ['src/server/standalone.ts', '--port', String(port), '--no-open'], { cwd: repo, env, stdio: 'ignore' })
    const base = `http://127.0.0.1:${port}`
    await expect.poll(async () => {
      if (server?.exitCode !== null) throw new Error(`server exited: ${server?.exitCode}`)
      try { return (await request.get(`${base}/api/fleet`, { timeout: 1000 }).then(response => response.json()) as { data?: { attention?: unknown[] } }).data?.attention?.length ?? 0 }
      catch { return 0 }
    }, { timeout: 15_000 }).toBe(homes.length)
    return { base, home: homes[0]!, homes, notes, snapshot, stop }
  } catch (error) {
    stop()
    throw error
  }
}

test('sliding a decision card to the end asks First Mate to dismiss it', async ({ page, request }) => {
  test.setTimeout(120_000)
  const { base, home, notes, snapshot, stop } = await startCockpit(request, ['firstmate'])
  try {
    const errors: string[] = []
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    await page.setViewportSize({ width: 1280, height: 1100 })
    await page.goto(base)
    const card = page.locator('.cockpit-attention-card')
    await expect(card).toHaveCount(1)
    const slider = card.getByRole('slider', { name: 'Slide to dismiss' })
    await expect(slider).toBeVisible()
    await page.setViewportSize({ width: 390, height: 800 })
    await slider.scrollIntoViewIfNeeded()
    await expect(slider).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('private-slide-narrow.png') })
    await page.setViewportSize({ width: 1280, height: 1100 })
    await slider.scrollIntoViewIfNeeded()
    await expect(card.getByText('dismissing…')).toHaveCount(0)
    await page.screenshot({ path: test.info().outputPath('private-slide-ready.png') })
    await slide(page, slider, 0.35)
    await expect(slider).toBeVisible()
    await expect(slider).toHaveAttribute('aria-valuenow', '0')
    await page.waitForTimeout(400)
    expect(notes()).toEqual([])
    await slide(page, slider, 1)
    await expect(card.getByRole('status')).toHaveText('dismissing…')
    await expect(slider).toHaveCount(0)
    await expect.poll(() => notes().length, { timeout: 10_000 }).toBe(1)
    const note = JSON.parse(readFileSync(join(home, 'state', notes()[0]!), 'utf8')) as { request_id: string; body: string }
    expect(note.body).toContain('task alpha')
    expect(note.body).toContain('decision choice')
    expect(note.body).toContain('Dismiss decision choice on task alpha.')
    await expect(page.getByText('Dismiss decision choice on task alpha.')).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: test.info().outputPath('private-slide-dismissing.png') })
    const first = join(home, 'state', notes()[0]!)
    writeFileSync(first, JSON.stringify({ ...note, reply: { body: 'Keeping this decision open.' } }))
    await expect(slider).toBeVisible({ timeout: 15_000 })
    await expect(card.getByText('dismissing…')).toHaveCount(0)
    await slide(page, slider, 1)
    await expect(card.getByRole('status')).toHaveText('dismissing…')
    await expect.poll(() => notes().length, { timeout: 10_000 }).toBe(2)
    await page.reload()
    await expect(card.getByRole('status')).toHaveText('dismissing…', { timeout: 15_000 })
    expect(notes()).toHaveLength(2)
    snapshot(false)
    appendFileSync(join(home, 'state', 'fleet-ledger.jsonl'), '{}\n')
    await expect(card).toHaveCount(0, { timeout: 30_000 })
    await page.screenshot({ path: test.info().outputPath('private-slide-gone.png') })
    await expect.poll(async () => ((await request.get(`${base}/api/fleet/messages`).then(response => response.json())) as { data: { text: string }[] })
      .data.filter(message => message.text === 'Dismiss decision choice on task alpha.').length, { timeout: 30_000 }).toBe(0)
    snapshot(true)
    appendFileSync(join(home, 'state', 'fleet-ledger.jsonl'), '{}\n')
    await expect(card).toHaveCount(1, { timeout: 30_000 })
    await expect(slider).toBeVisible({ timeout: 15_000 })
    await expect(card.getByText('dismissing…')).toHaveCount(0)
    expect(errors).toEqual([])
  } finally {
    stop()
  }
})

test('a dismiss note only holds the card from its own First Mate home', async ({ page, request }) => {
  test.setTimeout(120_000)
  const { base, homes, notes, stop } = await startCockpit(request, ['first', 'second'])
  try {
    await page.setViewportSize({ width: 1280, height: 1100 })
    await page.goto(base)
    const cards = page.locator('.cockpit-attention-card')
    await expect(cards).toHaveCount(2)
    await slide(page, cards.nth(0).getByRole('slider', { name: 'Slide to dismiss' }), 1)
    await expect(cards.nth(0).getByRole('status')).toHaveText('dismissing…')
    await expect.poll(() => notes(homes[0]).length, { timeout: 10_000 }).toBe(1)
    await page.reload()
    await expect(cards.nth(0).getByRole('status')).toHaveText('dismissing…', { timeout: 15_000 })
    const other = cards.nth(1).getByRole('slider', { name: 'Slide to dismiss' })
    await expect(other).toBeVisible()
    await slide(page, other, 1)
    await expect(cards.nth(1).getByRole('status')).toHaveText('dismissing…')
    await expect.poll(() => notes(homes[1]).length, { timeout: 10_000 }).toBe(1)
    expect(notes(homes[0])).toHaveLength(1)
  } finally {
    stop()
  }
})

test('a failing First Mate home does not stop a card from being dismissed again', async ({ page, request }) => {
  test.setTimeout(120_000)
  const { base, homes, notes, stop } = await startCockpit(request, ['first', 'second'])
  try {
    writeFileSync(join(homes[1]!, 'bin', 'fm-fleet-snapshot.sh'), '#!/bin/sh\nexit 1\n')
    appendFileSync(join(homes[1]!, 'state', 'fleet-ledger.jsonl'), '{}\n')
    await page.setViewportSize({ width: 1280, height: 1100 })
    await page.goto(base)
    await expect(page.getByRole('alert').filter({ hasText: 'Needs You unavailable' })).toBeVisible({ timeout: 30_000 })
    const card = page.locator('.cockpit-attention-card').nth(0)
    const slider = card.getByRole('slider', { name: 'Slide to dismiss' })
    await slide(page, slider, 1)
    await expect(card.getByRole('status')).toHaveText('dismissing…', { timeout: 15_000 })
    await expect.poll(() => notes(homes[0]).length, { timeout: 10_000 }).toBe(1)
    const first = join(homes[0]!, 'state', notes(homes[0])[0]!)
    writeFileSync(first, JSON.stringify({ ...JSON.parse(readFileSync(first, 'utf8')), reply: { body: 'Keeping this decision open.' } }))
    await expect(slider).toBeVisible({ timeout: 15_000 })
    await slide(page, slider, 1)
    await expect.poll(() => notes(homes[0]).length, { timeout: 10_000 }).toBe(2)
  } finally {
    stop()
  }
})

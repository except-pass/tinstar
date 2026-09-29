import { test, expect } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')

test('messages survive reload and follow First Mate receipts and call resolution', async ({ page, request }) => {
  test.setTimeout(120_000)
  const root = mkdtempSync(join(tmpdir(), 'tinstar-inbox-'))
  const home = join(root, 'firstmate')
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const socket = `cockpit-inbox-${process.pid}-${Date.now()}`
  const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
  const port = 39000 + Math.floor(Math.random() * 10000)
  let server: ChildProcess | null = null
  const snapshot = (open: boolean) => writeFileSync(join(home, 'snapshot.json'), JSON.stringify({
    schema: 'fm-fleet-snapshot.v1',
    tasks: [{ id: 'alpha', kind: 'worker', project: 'private-project', branch: 'fm/alpha',
      paths: { worktree: { path: '/private/worktrees/alpha' } }, current_state: { state: 'paused', detail: 'Waiting for a decision', freshness: 'fresh' },
      endpoint: { target: null }, hints: { open_decisions: open ? [{ key: 'choice', verb: 'needs-decision', summary: 'Choose the rollout order' }] : [] } }],
    backlog: { records: open ? [{ id: 'alpha-decision-choice', state: 'held', hold_kind: 'captain', hold_reason: 'Choose the rollout order', title: 'Rollout order' }] : [] },
  }))
  try {
    for (const path of [home, config, bin, join(home, 'bin'), join(home, 'state')]) mkdirSync(path, { recursive: true })
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -L '${socket}' -f /dev/null "$@"\n`)
    chmodSync(join(bin, 'tmux'), 0o755)
    writeFileSync(join(config, 'config.json'), JSON.stringify({ firstmate: { homes: [home] } }))
    writeFileSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), `#!/bin/sh\ncat '${join(home, 'snapshot.json')}'\n`)
    chmodSync(join(home, 'bin', 'fm-fleet-snapshot.sh'), 0o755)
    const inbox = join(home, 'bin', 'fm-inbox.sh')
    writeFileSync(inbox, `#!/usr/bin/env python3
import json, pathlib, sys, time
state = pathlib.Path(__file__).resolve().parent.parent / 'state'
command = sys.argv[1]
if command == 'note':
    request_id = sys.argv[sys.argv.index('--request-id') + 1]
    path = state / (request_id + '.json')
    if not path.exists(): path.write_text(json.dumps({'request_id': request_id, 'body': sys.stdin.read()}))
    time.sleep(1)
    print(json.dumps({'schema': 'fm-inbox-note.v1', 'saved': True, 'id': request_id}))
elif command == 'receipts':
    rows = []
    for path in state.glob('tinstar-*.json'):
        row = json.loads(path.read_text())
        row['acknowledged'] = (state / 'acked').exists()
        row['reply'] = {'body': (state / 'reply').read_text()} if (state / 'reply').exists() else None
        rows.append(row)
    print(json.dumps({'schema': 'fm-inbox-receipts.v1', 'pending': [] if (state / 'acked').exists() else rows, 'handled': rows if (state / 'acked').exists() else []}))
elif command == 'ready':
    print(json.dumps({'can_receive': False}))
`)
    chmodSync(inbox, 0o755)
    snapshot(true)
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TINSTAR_CONFIG_HOME: config, TINSTAR_NO_SESSIONS: '1', TINSTAR_CORS_ORIGINS: `http://127.0.0.1:${port}` }
    delete env.TMUX
    delete env.TMUX_PANE
    server = spawn(join(repo, 'node_modules', '.bin', 'tsx'), ['src/server/standalone.ts', '--port', String(port), '--no-open'], { cwd: repo, env, stdio: 'ignore' })
    const base = `http://127.0.0.1:${port}`
    await expect.poll(async () => {
      if (server?.exitCode !== null) throw new Error(`server exited: ${server?.exitCode}`)
      try { return (await request.get(`${base}/api/fleet`, { timeout: 1000 }).then(response => response.json()) as { data?: { attention?: unknown[] } }).data?.attention?.length ?? 0 }
      catch { return 0 }
    }, { timeout: 15_000 }).toBe(1)
    const errors: string[] = []
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`) })
    await page.goto(base)
    const crossOrigin = await request.post(`${base}/api/fleet/messages`, {
      headers: { Origin: 'https://unrelated.example' },
      data: { requestId: 'tinstar-00000000-0000-4000-8000-000000000002', anchorKey: 'attention-0:alpha:decision:choice', kind: 'answer', text: 'Ignore this' },
    })
    expect(crossOrigin.status()).toBe(403)
    const card = page.locator('.cockpit-attention-card')
    await expect(card).toHaveCount(1)
    await card.locator('summary', { hasText: 'Answer' }).click()
    await card.getByRole('textbox', { name: 'Answer this decision' }).fill('Start with the smaller group.')
    await page.screenshot({ path: test.info().outputPath('private-answer-ready.png') })
    await card.getByRole('button', { name: 'Send to First Mate' }).click()
    await expect(card.getByRole('button', { name: 'Sending…' })).toBeVisible()
    await page.screenshot({ path: test.info().outputPath('private-sending.png') })
    await expect(card.locator('.cockpit-composer p')).toHaveText('Saved, not yet read. First Mate will read it when it wakes.')
    await page.screenshot({ path: test.info().outputPath('private-saved-not-read.png') })
    const noteFiles = readdirSync(join(home, 'state')).filter(name => name.startsWith('tinstar-') && name.endsWith('.json'))
    expect(noteFiles).toHaveLength(1)
    const note = JSON.parse(readFileSync(join(home, 'state', noteFiles[0]!), 'utf8')) as { request_id: string; body: string }
    expect(note.body).toContain('Answer for task alpha, decision choice, hold alpha-decision-choice (Choose the rollout order):')
    expect(note.body).toContain('Start with the smaller group.')
    await request.post(`${base}/api/fleet/messages`, { data: { requestId: note.request_id, anchorKey: 'attention-0:alpha:decision:choice', kind: 'answer', text: 'Start with the smaller group.' } })
    expect(readdirSync(join(home, 'state')).filter(name => name.startsWith('tinstar-') && name.endsWith('.json'))).toHaveLength(1)
    await page.reload()
    await expect(page.locator('.cockpit-messages small')).toHaveText('Saved, not yet read. First Mate will read it when it wakes.')
    writeFileSync(join(home, 'state', 'acked'), '')
    await expect(page.getByText('First Mate has it')).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(6_000)
    await page.reload()
    await expect(page.getByText('First Mate has it')).toBeVisible({ timeout: 15_000 })
    writeFileSync(join(home, 'state', 'reply'), 'Rollout order recorded.')
    await expect(page.getByText('Rollout order recorded.')).toBeVisible({ timeout: 15_000 })
    await page.screenshot({ path: test.info().outputPath('private-acknowledged-reply.png') })
    snapshot(false)
    appendFileSync(join(home, 'state', 'fleet-ledger.jsonl'), '{}\n')
    await expect(card).toHaveCount(0, { timeout: 30_000 })
    await expect(page.locator('.cockpit-messages article')).toHaveCount(0, { timeout: 15_000 })
    await page.screenshot({ path: test.info().outputPath('private-call-done.png') })
    expect(errors).toEqual([])
  } finally {
    server?.kill('SIGTERM')
    try { execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', 'kill-server']) } catch { /* private server absent */ }
    rmSync(root, { recursive: true, force: true })
  }
})

import { installDeskAttention } from '../test-fixtures/reconciliation/deskAttention'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')

type DismissKind = 'fallback' | 'keyed' | 'blocked' | 'hold' | 'held-work'

async function startCockpit(request: APIRequestContext, names: string[], kind: DismissKind = 'fallback') {
  const root = mkdtempSync(join(tmpdir(), 'tinstar-dismiss-'))
  const homes = names.map(name => join(root, name))
  const config = join(root, 'config')
  const bin = join(root, 'bin')
  const socket = `cockpit-dismiss-${process.pid}-${Date.now()}`
  const realTmux = execFileSync('which', ['tmux'], { encoding: 'utf8' }).trim()
  const port = 39000 + Math.floor(Math.random() * 10000)
  let server: ChildProcess | null = null
  const notes = (home = homes[0]!) => readdirSync(join(home, 'state')).filter(name => name.startsWith('tinstar-') && name.endsWith('.json'))
  const calls = (home = homes[0]!) => {
    const path = join(home, 'state', 'calls.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { script: string; argv: string[]; fm_home: string | null; decision: string })
  }
  const snapshot = (open: boolean, home = homes[0]!) => {
    const decisions = !open ? []
      : kind === 'blocked' ? [{ key: 'access', verb: 'blocked', summary: 'Need repository access' }]
      : kind === 'keyed' ? [{ key: 'choice', verb: 'needs-decision', summary: 'Choose the rollout order' }]
      : kind === 'fallback' ? [{ verb: 'needs-decision', summary: 'Choose the rollout order' }]
      : []
    const holds = !open ? []
      : kind === 'hold' ? [{ id: 'rollout-call', state: 'queued', hold_kind: 'captain', hold_reason: 'Choose the rollout order', title: 'Rollout order', hold_age_days: 2 }]
      : kind === 'held-work' ? [{ id: 'alpha', state: 'in_flight', hold_kind: 'captain', hold_reason: 'Hold the rollout until the captain says go', title: 'Rollout', hold_age_days: 1 }]
      : []
    writeFileSync(join(home, 'snapshot.json'), JSON.stringify({
      schema: 'fm-fleet-snapshot.v1',
      tasks: [{ id: 'alpha', kind: 'worker', project: 'private-project', branch: 'fm/alpha',
        paths: { worktree: { path: '/private/worktrees/alpha' } }, current_state: { state: 'paused', detail: 'Waiting for a decision', freshness: 'fresh' },
        endpoint: { target: null }, hints: { open_decisions: decisions } }],
      backlog: { records: holds },
    }))
  }
  const stop = () => {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM')
      const deadline = Date.now() + 2_000
      while (server.exitCode === null && Date.now() < deadline) execFileSync('sleep', ['0.05'])
      if (server.exitCode === null) server.kill('SIGKILL')
    }
    try { execFileSync(realTmux, ['-L', socket, '-f', '/dev/null', 'kill-server']) } catch { /* private server absent */ }
    // macOS rmSync throws ENOTEMPTY while the signaled server still has this temp home open.
    for (let attempt = 0; ; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3 })
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if ((code !== 'ENOTEMPTY' && code !== 'EBUSY') || attempt >= 4) throw error
        execFileSync('sleep', ['0.05'])
      }
    }
  }
  try {
    for (const path of [config, bin]) mkdirSync(path, { recursive: true })
    writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nexec '${realTmux}' -L '${socket}' -f /dev/null "$@"\n`)
    chmodSync(join(bin, 'tmux'), 0o755)
    writeFileSync(join(bin, 'quota-axi'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
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
      const close = join(home, 'bin', 'fm-send.sh')
      writeFileSync(close, `#!/usr/bin/env python3
import json, os, pathlib, sys, time
state = pathlib.Path(__file__).resolve().parent.parent / 'state'
argv = sys.argv[1:]
name = pathlib.Path(sys.argv[0]).name
if (state / 'slow').exists():
    time.sleep(2)
decision = ''
if '--decision-file' in argv:
    decision = pathlib.Path(argv[argv.index('--decision-file') + 1]).read_text()
with (state / 'calls.jsonl').open('a') as handle:
    handle.write(json.dumps({'script': name, 'argv': argv, 'fm_home': os.environ.get('FM_HOME'), 'decision': decision}) + '\\n')
if name == 'fm-send.sh' and (state / 'fail-send').exists():
    sys.stderr.write('fm-send: could not close the decision\\n')
    sys.exit(1)
if name == 'fm-captain-hold.sh' and (state / 'fail-hold').exists():
    sys.stderr.write('fm-captain-hold: task is not held\\n')
    sys.exit(1)
`)
      writeFileSync(join(home, 'bin', 'fm-captain-hold.sh'), readFileSync(close))
      chmodSync(close, 0o755)
      chmodSync(join(home, 'bin', 'fm-captain-hold.sh'), 0o755)
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
    return { base, home: homes[0]!, homes, notes, calls, snapshot, stop }
  } catch (error) {
    stop()
    throw error
  }
}

for (const kind of ['keyed', 'held-work'] as const) test(`Decisions keeps ${kind} source controls and adds the shared Ask composer`, async ({ page, request }) => {
  const { base, notes, calls, stop } = await startCockpit(request, ['firstmate'], kind)
  try {
    await installDeskAttention(page, base)
    await page.goto(base)
    await page.getByRole('navigation', { name: 'Activity' }).getByRole('button', { name: 'Decisions', exact: true }).click()
    await page.locator('.decisions-row').first().click()
    const desk = page.getByLabel('Selected decision')
    await expect(desk.getByRole('heading', { level: 2 })).toBeVisible()
    await desk.getByText('Evidence and delivery details', { exact: true }).click()
    await expect(desk.getByRole('link', { name: 'Open source terminal' })).toHaveAttribute('href', /worker=alpha/)
    await expect(desk.getByRole('textbox')).toHaveCount(1)
    await expect(desk.getByRole('button', { name: 'Record voice question' })).toHaveCount(1)
    await expect(desk.getByRole('slider')).toHaveCount(0)
    await expect(desk.getByRole('button', { name: /Answer|Dismiss|Send to First Mate/i })).toHaveCount(0)
    expect(notes()).toHaveLength(0)
    expect(calls()).toHaveLength(0)
  } finally { stop() }
})

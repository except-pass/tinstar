import { afterEach, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttentionCard } from './attention'
import { dismissDirect } from './dismiss'

const WORKER_TEXT = 'The operator dismissed this decision from Tin Star; it no longer needs an answer. Carry on without it.'
const CAPTAIN_TEXT = 'Dismissed by the operator from Tin Star.'
let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }) })

function card(over: Partial<AttentionCard>): AttentionCard {
  return {
    key: 'attention-0:alpha:decision:choice', homeIndex: 0, taskId: 'alpha', decisionKey: 'choice',
    holdId: null, dismissal: 'resolve-key', type: 'decision', headline: 'Choose the rollout order', detail: '',
    workerKey: 'cockpit-0-alpha', workerId: 'alpha', ageDays: null, prUrl: null, repository: null,
    prNumber: null, reviewStatus: null, ci: 'unknown', ...over,
  }
}

function install(fail: 'send' | 'hold' | null = null) {
  if (root) rmSync(root, { recursive: true, force: true })
  root = mkdtempSync(join(tmpdir(), 'tinstar-dismiss-direct-'))
  const home = join(root, 'firstmate')
  mkdirSync(join(home, 'bin'), { recursive: true })
  mkdirSync(join(home, 'state'), { recursive: true })
  if (fail) writeFileSync(join(home, 'state', fail === 'send' ? 'fail-send' : 'fail-hold'), '')
  writeFileSync(join(home, 'bin', 'fm-send.sh'), `#!/usr/bin/env python3
import json, os, pathlib, sys
state = pathlib.Path(__file__).resolve().parent.parent / 'state'
argv = sys.argv[1:]
name = pathlib.Path(sys.argv[0]).name
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
  writeFileSync(join(home, 'bin', 'fm-captain-hold.sh'), readFileSync(join(home, 'bin', 'fm-send.sh')))
  chmodSync(join(home, 'bin', 'fm-send.sh'), 0o755)
  chmodSync(join(home, 'bin', 'fm-captain-hold.sh'), 0o755)
  return home
}

function calls(home: string) {
  const path = join(home, 'state', 'calls.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { script: string; argv: string[]; fm_home: string; decision: string })
}

it('closes a keyed decision with fm-send and a captain hold with fm-captain-hold', async () => {
  const home = install()
  expect(await dismissDirect(home, card({}))).toEqual({ dismissed: true })
  expect(calls(home)).toEqual([{
    script: 'fm-send.sh', argv: ['alpha', '--resolve-key', 'choice', WORKER_TEXT], fm_home: home, decision: '',
  }])
  expect(await dismissDirect(home, card({
    dismissal: 'captain-hold', holdId: 'rollout-call', decisionKey: 'rollout-call', taskId: null, workerId: null, workerKey: null,
  }))).toEqual({ dismissed: true })
  const recorded = calls(home)[1]!
  expect(recorded.script).toBe('fm-captain-hold.sh')
  expect(recorded.argv.slice(0, 3)).toEqual(['answer', 'rollout-call', '--decision-file'])
  expect(recorded.argv).toHaveLength(4)
  expect(recorded.decision).toBe(CAPTAIN_TEXT)
  expect(recorded.fm_home).toBe(home)
  expect(existsSync(recorded.argv[3]!)).toBe(false)
})

it('releases a hold on a live worker\'s own task instead of closing it', async () => {
  const home = install()
  expect(await dismissDirect(home, card({ dismissal: 'captain-hold', holdId: 'alpha', decisionKey: 'alpha' }))).toEqual({ dismissed: true })
  const recorded = calls(home)[0]!
  expect(recorded.script).toBe('fm-captain-hold.sh')
  expect(recorded.argv.slice(0, 3)).toEqual(['answer', 'alpha', '--decision-file'])
  expect(recorded.argv.slice(4)).toEqual(['--release'])
  expect(recorded.decision).toBe(CAPTAIN_TEXT)
  expect(await dismissDirect(home, card({ dismissal: 'captain-hold', holdId: 'alpha-release', decisionKey: 'default' }))).toEqual({ dismissed: true })
  expect(calls(home)[1]!.argv.slice(0, 2)).toEqual(['answer', 'alpha-release'])
  expect(calls(home)[1]!.argv).toHaveLength(4)
})

it('returns the script error and leaves the decision file removed when the close fails', async () => {
  const home = install('hold')
  const result = await dismissDirect(home, card({ dismissal: 'captain-hold', holdId: 'rollout-call', decisionKey: 'rollout-call' }))
  expect(result).toEqual({ dismissed: false, error: 'fm-captain-hold: task is not held' })
  expect(existsSync(calls(home)[0]!.argv[3]!)).toBe(false)
  const sendHome = install('send')
  expect(await dismissDirect(sendHome, card({}))).toEqual({ dismissed: false, error: 'fm-send: could not close the decision' })
})

it('reports a missing script instead of closing by another path', async () => {
  root = mkdtempSync(join(tmpdir(), 'tinstar-dismiss-missing-'))
  const home = join(root, 'firstmate')
  mkdirSync(join(home, 'bin'), { recursive: true })
  const result = await dismissDirect(home, card({}))
  expect(result.dismissed).toBe(false)
  if (!result.dismissed) expect(result.error).toContain('fm-send.sh')
})

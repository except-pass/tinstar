import { afterEach, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FleetOutbox, type OutboxMessage } from './inbox'

const originalRoot = process.env.TINSTAR_CONFIG_HOME
let root = ''
afterEach(() => {
  if (originalRoot === undefined) delete process.env.TINSTAR_CONFIG_HOME
  else process.env.TINSTAR_CONFIG_HOME = originalRoot
  if (root) rmSync(root, { recursive: true, force: true })
})

it('keeps one unfinished request across retry and reload, follows receipts and call resolution, and reports unreadable homes', async () => {
  root = mkdtempSync(join(tmpdir(), 'tinstar-outbox-'))
  process.env.TINSTAR_CONFIG_HOME = join(root, 'config')
  const home = join(root, 'firstmate')
  mkdirSync(join(home, 'bin'), { recursive: true })
  const script = join(home, 'bin', 'fm-inbox.sh')
  writeFileSync(script, `#!/usr/bin/env python3
import json, pathlib, sys
home = pathlib.Path(__file__).resolve().parent.parent
state = home / 'state'
state.mkdir(exist_ok=True)
command = sys.argv[1]
if (state / 'broken').exists():
    sys.stderr.write('fm-inbox: invalid request id\\n')
    sys.exit(1)
if command == 'note':
    request_id = sys.argv[sys.argv.index('--request-id') + 1]
    path = state / (request_id + '.json')
    body = sys.stdin.read()
    if not path.exists():
        path.write_text(json.dumps({'request_id': request_id, 'body': body}))
    print(json.dumps({'schema': 'fm-inbox-note.v1', 'outcome': 'replay' if path.read_text() != json.dumps({'request_id': request_id, 'body': body}) else 'created', 'saved': True}))
elif command == 'receipts':
    rows = []
    for path in state.glob('tinstar-*.json'):
        row = json.loads(path.read_text())
        row['acknowledged'] = (state / 'acked').exists()
        row['announced'] = False
        row['reply'] = {'body': (state / 'reply').read_text()} if (state / 'reply').exists() else None
        rows.append(row)
    print(json.dumps({'schema': 'fm-inbox-receipts.v1', 'pending': [] if (state / 'acked').exists() else rows, 'handled': rows if (state / 'acked').exists() else []}))
elif command == 'ready':
    print(json.dumps({'can_receive': False}))
`)
  chmodSync(script, 0o755)
  const message: OutboxMessage = {
    requestId: 'tinstar-00000000-0000-4000-8000-000000000001', home, kind: 'answer',
    taskId: 'alpha', decisionKey: 'choice', holdId: 'alpha-decision-choice', text: 'Use option A.',
  }
  const target = 'Answer for task alpha, decision choice (Choose a rollout order)'
  const outboxFile = join(root, 'config', 'fleet-outbox.json')
  const first = new FleetOutbox()
  expect(await first.list([home], () => true)).toEqual([])
  expect(await first.submit(message, target)).toEqual({ saved: true, error: null, canReceive: false })
  expect((await first.submit(message, target)).saved).toBe(true)
  const files = readFileSync(join(home, 'state', `${message.requestId}.json`), 'utf8')
  expect(JSON.parse(files).body).toBe('Answer for task alpha, decision choice (Choose a rollout order):\nUse option A.')
  expect(JSON.parse(readFileSync(outboxFile, 'utf8'))).toEqual([message])
  const reloaded = new FleetOutbox()
  expect(await reloaded.list([home], () => true))
    .toMatchObject([{ requestId: message.requestId, state: 'saved', announced: false, canReceive: false }])
  writeFileSync(join(home, 'state', 'acked'), '')
  writeFileSync(join(home, 'state', 'reply'), 'Option A recorded.')
  expect(await reloaded.list([home], () => true))
    .toMatchObject([{ state: 'acknowledged', reply: 'Option A recorded.' }])
  await expect.poll(() => JSON.parse(readFileSync(outboxFile, 'utf8'))).toEqual([])
  expect(await reloaded.list([home], () => false, false)).toMatchObject([{ state: 'acknowledged' }])
  expect(await reloaded.list([home], () => false)).toMatchObject([{ state: 'done' }])
  expect(await new FleetOutbox().list([home], () => false)).toEqual([])
  writeFileSync(join(home, 'state', 'broken'), '')
  expect(await reloaded.list([home], () => true)).toMatchObject([{ state: 'unknown', canReceive: 'unknown' }])
  expect(await new FleetOutbox().submit({ ...message, requestId: 'tinstar-00000000-0000-4000-8000-000000000002' }, target))
    .toEqual({ saved: false, error: 'fm-inbox: invalid request id', canReceive: 'unknown' })
})

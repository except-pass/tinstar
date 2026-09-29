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

it('keeps one request across retry and reload, then follows receipt and call resolution', async () => {
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
        row['reply'] = {'body': (state / 'reply').read_text()} if (state / 'reply').exists() else None
        rows.append(row)
    print(json.dumps({'schema': 'fm-inbox-receipts.v1', 'pending': [] if (state / 'acked').exists() else rows, 'handled': rows if (state / 'acked').exists() else []}))
elif command == 'ready':
    print(json.dumps({'can_receive': False}))
`)
  chmodSync(script, 0o755)
  const message: OutboxMessage = {
    requestId: 'tinstar-00000000-0000-4000-8000-000000000001', anchorKey: 'attention-0:alpha:decision:choice',
    homeIndex: 0, taskId: 'alpha', cardKey: 'attention-0:alpha:decision:choice', decisionKey: 'choice', kind: 'answer', text: 'Use option A.',
    context: 'Choose a rollout order',
  }
  const first = new FleetOutbox()
  expect((await first.submit(home, message)).saved).toBe(true)
  expect((await first.submit(home, message)).saved).toBe(true)
  const files = readFileSync(join(home, 'state', `${message.requestId}.json`), 'utf8')
  expect(JSON.parse(files).body).toBe('Answer for task alpha, decision choice (Choose a rollout order):\nUse option A.')
  const reloaded = new FleetOutbox()
  expect(await reloaded.list([home], new Set([message.cardKey!])))
    .toMatchObject([{ requestId: message.requestId, state: 'saved', canReceive: false }])
  writeFileSync(join(home, 'state', 'acked'), '')
  writeFileSync(join(home, 'state', 'reply'), 'Option A recorded.')
  expect(await reloaded.list([home], new Set([message.cardKey!])))
    .toMatchObject([{ state: 'acknowledged', reply: 'Option A recorded.' }])
  expect(await reloaded.list([home], new Set(), false)).toMatchObject([{ state: 'acknowledged' }])
  expect(await reloaded.list([home], new Set())).toMatchObject([{ state: 'done' }])
})

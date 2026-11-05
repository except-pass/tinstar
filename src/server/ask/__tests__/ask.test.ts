import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { AskApi } from '../routes'
import { AskStore } from '../store'
import { askContextSchema, askBody, bridgeUpdateSchema, inboxRequestId, publicAsk } from '../../../shared/ask'
import { fixtureId, fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'

const exec = promisify(execFile)
const token = 'isolated-test-bridge-token-1234567890'
let root = '', server: Server | undefined
const owner = 'owner@example.test', other = 'other@example.test'
const view = { scene: 'overview' as const }
const context = () => askContextSchema.parse({ anchor: { kind: 'work', page_id: fixtureId(1), label: 'Task', url: `https://www.notion.so/${fixtureId(1)}`, observed_at: null }, view })
const note = (id: string, noteId = 'note-1', announced = true) => ({ schema: 'fm-inbox-note.v1' as const, outcome: 'created' as const, id: noteId, request_id: inboxRequestId(id), saved: true as const, announced, acknowledged: false })
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined }; if (root) await rm(root, { recursive: true, force: true }); resetOriginAllowlistForTests() })
async function setup() {
  root = await mkdtemp(join(tmpdir(), 'tinstar-ask-'))
  let api = new AskApi({ scene: async () => fixtureScene() }, root, async () => ({ ownerLogins: [owner, other], bridgeToken: token }))
  server = createServer((req, res) => { void api.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end() } }) })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  seedOriginAllowlist(address.port)
  const base = `http://127.0.0.1:${address.port}`
  const call = async (path: string, body?: unknown, headers: Record<string, string> = { 'Tailscale-User-Login': owner, 'X-Tinstar-UI': '1' }) => {
    const response = await fetch(base + '/api/ask/' + path, { headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json() }
  }
  const bridge = (body?: unknown) => call('bridge', body, { Authorization: `Bearer ${token}` })
  const reload = () => { api = new AskApi({ scene: async () => fixtureScene() }, root, async () => ({ ownerLogins: [owner, other], bridgeToken: token })) }
  return { call, bridge, reload, base }
}
const input = (clientKey = randomUUID()) => ({ client_key: clientKey, card_id: fixtureId(1), question: 'Why is this waiting?', view })

describe('owner-scoped durable Ask protocol', () => {
  it('fails closed on owner/header/token mistakes and never accepts a browser principal', async () => {
    const { call } = await setup()
    expect((await call('requests', undefined, {})).status).toBe(403)
    expect((await call('requests', undefined, { 'Tailscale-User-Login': 'stranger@example.test', 'X-Tinstar-UI': '1' })).status).toBe(403)
    expect((await call('requests', undefined, { 'Tailscale-User-Login': owner })).status).toBe(403)
    expect((await call('bridge', undefined, { Authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await call('bridge', undefined, { Authorization: `Bearer ${token}`, Origin: 'http://evil.example' })).status).toBe(403)
    expect((await call('requests', { ...input(), owner: other })).status).toBe(400)
    expect((await call('requests', { ...input(), card_id: fixtureId(99) })).status).toBe(404)
  })
  it('retains a single request through retry, reload, real-shape capture and out-of-order replies', async () => {
    const { call, bridge, reload } = await setup()
    const body = input()
    const first = await call('requests', body), id = first.data.data.request_id
    expect(first.status).toBe(200)
    expect(first.data.data).toMatchObject({ status: 'sent', context: { anchor: { page_id: fixtureId(1), kind: 'work' } } })
    expect(JSON.stringify(first.data)).not.toContain(token)
    expect(first.data.data.owner).toBeUndefined()
    reload()
    expect((await call('requests', body)).data.data.request_id).toBe(id)
    expect((await call('requests', { ...body, question: 'Different' })).status).toBe(409)
    expect((await call('requests', undefined, { 'Tailscale-User-Login': other, 'X-Tinstar-UI': '1' })).data.data).toEqual([])
    expect((await bridge()).data.data.pending).toMatchObject([{ request_id: id, inbox_request_id: inboxRequestId(id) }])
    expect((await bridge({ request_id: id, note: { ...note(id), request_id: 'wrong' } })).status).toBe(409)
    expect((await bridge({ request_id: id, note: note(id) })).status).toBe(200)
    const reply = { id: 'note-1', at: new Date().toISOString(), body: 'I checked the actual dependency. Review is pending.', cursor: '000000000005' }
    expect((await bridge({ request_id: id, reply: { ...reply, id: 'someone-elses-note' } })).status).toBe(409)
    expect((await bridge({ request_id: id, reply })).status).toBe(200)
    await bridge({ request_id: id, note: note(id, 'note-1', false), error: 'capture-failed' })
    await bridge({ request_id: id, reply: { ...reply, cursor: '000000000004', body: 'stale' } })
    await bridge({ request_id: id, reply })
    await call(`requests/${id}/read`, {})
    reload()
    const listed = (await call('requests')).data.data
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ status: 'answered', error: null, reply: { detail: reply.body }, read_at: expect.any(String) })
    expect((await bridge({ request_id: id, reply: { ...reply, cursor: '000000000006', body: 'overwrite' } })).status).toBe(409)
    expect((await call(`requests/${id}/dismiss`, {}, { 'Tailscale-User-Login': other, 'X-Tinstar-UI': '1' })).status).toBe(404)
    await call(`requests/${id}/dismiss`, {})
    reload()
    expect((await call('requests')).data.data[0].dismissed_at).toEqual(expect.any(String))
    const follow = (await call('requests', { ...input(), follow_up_to: id })).data.data
    expect(follow.request_id).not.toBe(id)
    expect(follow.conversation_id).toBe(id)
    expect((await call('requests')).data.data).toHaveLength(2)
    expect((await readFile(join(root, 'ask-requests.json'), 'utf8'))).toContain(reply.body)
  })
  it.each(['漢', '\u0000', '😀'])('accepts a maximum-length escaped Unicode reply (%s)', async character => {
    const { call, bridge, base, reload } = await setup()
    const id = (await call('requests', input())).data.data.request_id
    await bridge({ request_id: id, note: note(id) })
    const body = character.repeat(32000 / character.length)
    const payload = { request_id: id, reply: { id: 'note-1', at: new Date().toISOString(), body, cursor: '1' } }
    const serialized = JSON.stringify(payload).replace(/[\u007f-\uffff]/g, value => '\\u' + value.charCodeAt(0).toString(16).padStart(4, '0'))
    const response = await fetch(base + '/api/ask/bridge', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: serialized })
    expect(response.status).toBe(200)
    reload()
    expect((await call('requests')).data.data[0]).toMatchObject({ status: 'answered', reply: { detail: body } })
  })
  it('reports capture/wake failures honestly and retries the same logical request', async () => {
    const { call, bridge } = await setup()
    const id = (await call('requests', input())).data.data.request_id
    await bridge({ request_id: id, error: 'capture-failed' })
    expect((await bridge()).data.data.pending).toHaveLength(0)
    expect((await call('requests')).data.data[0]).toMatchObject({ status: 'failed', error: expect.any(String) })
    await call(`requests/${id}/retry`, {})
    expect((await bridge()).data.data.pending[0].request_id).toBe(id)
    await bridge({ request_id: id, note: note(id, 'captured', false) })
    expect((await call('requests')).data.data[0]).toMatchObject({ status: 'delivered', error: expect.any(String) })
    await call(`requests/${id}/retry`, {})
    expect((await bridge()).data.data.pending[0].request_id).toBe(id)
    await bridge({ request_id: id, note: note(id, 'captured', true) })
    expect((await bridge()).data.data.pending).toHaveLength(0)
  })
  it('serializes concurrent creates, validates structured replies and never prunes old history', async () => {
    root = await mkdtemp(join(tmpdir(), 'tinstar-ask-'))
    const store = new AskStore(root, () => '2020-01-01T00:00:00.000Z'), key = randomUUID()
    const rows = await Promise.all(Array.from({ length: 6 }, () => store.create(owner, key, 'Question', context())))
    const id = rows[0]!.request_id
    expect(new Set(rows.map(row => row.request_id)).size).toBe(1)
    await store.ingest(bridgeUpdateSchema.parse({ request_id: id, note: note(id) }))
    const reply = { schema: 'tinstar.ask-reply.v1', request_id: String(randomUUID()), summary: 'Answer', detail: 'Evidence', references: [], suggested_actions: [] }
    await expect(store.ingest({ request_id: id, reply: { id: 'note-1', at: new Date().toISOString(), body: JSON.stringify(reply), cursor: '1' } })).rejects.toThrow('request does not match')
    reply.request_id = id
    await store.ingest({ request_id: id, reply: { id: 'note-1', at: new Date().toISOString(), body: JSON.stringify(reply), cursor: '1' } })
    const retained = (await new AskStore(root).list(owner))[0]!
    expect(retained.reply?.summary).toBe('Answer')
    expect(publicAsk(retained)).not.toHaveProperty('owner')
    expect(JSON.parse(askBody(retained).split('\n')[1]!)).toMatchObject({ request_id: id, requesting_principal: owner, context: context() })
  })
})

it('runs the outbound Mac puller against the real Tin Star HTTP API with isolated inbox and clavis stand-ins', async () => {
  const { call, base, reload } = await setup()
  const id = (await call('requests', input())).data.data.request_id
  const home = join(root, 'home'), bin = join(root, 'bin')
  await mkdir(join(home, 'bin'), { recursive: true }); await mkdir(bin)
  await writeFile(join(bin, 'clavis'), `#!/bin/sh\nprintf '%s' '${token}'\n`)
  await chmod(join(bin, 'clavis'), 0o700)
  const script = join(home, 'bin', 'fm-inbox.sh')
  await writeFile(script, `#!/usr/bin/env python3
import json, os, pathlib, sys
home = pathlib.Path(os.environ['FM_HOME'])
p = home / 'note.json'
if sys.argv[1] == 'note':
    request = sys.argv[sys.argv.index('--request-id') + 1]
    body = sys.stdin.read()
    if not p.exists(): p.write_text(json.dumps({'request_id':request,'body':body}))
    print(json.dumps({'schema':'fm-inbox-note.v1','outcome':'replay' if p.exists() else 'created','id':'proof-note','request_id':request,'saved':True,'announced':True,'acknowledged':False}))
elif sys.argv[1] == 'receipts':
    n = json.loads(p.read_text())
    reply = json.loads((home / 'reply.json').read_text()) if (home / 'reply.json').exists() else None
    print(json.dumps({'schema':'fm-inbox-receipts.v1','pending':[{'id':'proof-note','request_id':n['request_id'],'reply':reply}],'handled':[],'omitted':[]}))
`)
  await chmod(script, 0o700)
  // Import and call the executable pass: production CLI requires HTTPS, while
  // the isolated HTTP fixture binds only an ephemeral loopback listener.
  const driver = `import importlib.util,pathlib,sys\ns=importlib.util.spec_from_file_location('puller',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nprint(m.pull_once(sys.argv[2],sys.stdin.read(),pathlib.Path(sys.argv[3])))`
  const run = () => new Promise<string>((resolveRun, reject) => {
    const child = execFile('python3', ['-c', driver, resolve('scripts/ask-puller.py'), base, home], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }, (error, stdout) => error ? reject(error) : resolveRun(stdout))
    child.stdin!.end(token)
  })
  await run(); await run(); reload()
  expect((await call('requests')).data.data[0].status).toBe('delivered')
  expect(JSON.parse(await readFile(join(home, 'note.json'), 'utf8')).request_id).toBe(inboxRequestId(id))
  await writeFile(join(home, 'reply.json'), JSON.stringify({ id: 'proof-note', at: new Date().toISOString(), body: 'Stand-in answer for adapter behavior only', cursor: '000000000001' }))
  await run(); await run(); reload()
  expect((await call('requests')).data.data).toMatchObject([{ request_id: id, status: 'answered', reply: { detail: 'Stand-in answer for adapter behavior only' } }])
  const cli = await exec('python3', ['scripts/ask-puller.py', '--url', base, '--home', home, '--token-key', 'test.ask'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).catch(error => error)
  expect(cli.stderr).toContain('must be an HTTPS origin')
})

it('checks the standalone puller CLI security and retry behavior', async () => {
  const result = await exec('python3', ['-m', 'unittest', 'discover', '-s', 'scripts/tests', '-p', 'test_ask_puller.py'])
  expect(result.stderr).toContain('OK')
})

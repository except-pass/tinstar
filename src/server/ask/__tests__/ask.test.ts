import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { publishedPullerContract } from '../../../../test-fixtures/published-puller/contract'
import type { AskArtifactSources } from '../artifacts'
import { releaseAssociations } from '../../../shared/releases'
import type { PullsRead } from '../../../shared/pulls'
import { AskApi } from '../routes'
import { AskStore } from '../store'
import { askContextSchema, askBody, bridgeUpdateSchema, inboxRequestId, publicAsk } from '../../../shared/ask'
import { deskConversations } from '../../../ask/deskInbox'
import type { AskAction } from '../../../shared/ask-actions'
import { fixtureId, fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { boundSearchDocuments, sceneSearchDocuments } from '../../../shared/searchDocuments'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'

const exec = promisify(execFile)
const token = 'isolated-test-bridge-token-1234567890'
let root = '', server: Server | undefined
const owner = 'owner@example.test', other = 'other@example.test'
const view = { scene: 'overview' as const }
const context = () => askContextSchema.parse({ anchor: { kind: 'work', page_id: fixtureId(1), label: 'Task', url: `https://www.notion.so/${fixtureId(1)}`, observed_at: null }, view })
const note = (id: string, noteId = 'note-1', announced = true) => ({ schema: 'fm-inbox-note.v1' as const, outcome: 'created' as const, id: noteId, request_id: inboxRequestId(id), saved: true as const, announced, acknowledged: false })
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined }; if (root) await rm(root, { recursive: true, force: true }); resetOriginAllowlistForTests() })
async function setup(artifacts?: AskArtifactSources) {
  root = await mkdtemp(join(tmpdir(), 'tinstar-ask-'))
  const sources = { scene: async () => {
    const scene = fixtureScene()
    return { ...scene, searchIndex: boundSearchDocuments(sceneSearchDocuments(scene)) }
  } }
  let api = new AskApi(sources, root, async () => ({ ownerLogins: [owner, other], bridgeToken: token }), artifacts)
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
  const reload = () => { api = new AskApi(sources, root, async () => ({ ownerLogins: [owner, other], bridgeToken: token }), artifacts) }
  return { call, bridge, reload, base }
}
const input = (clientKey = randomUUID()) => ({ client_key: clientKey, card_id: fixtureId(1), question: 'Why is this waiting?', view })

describe('versioned bridge negotiation', () => {
  it('advertises the contract and accepts released unversioned and current clients', async () => {
    const { base } = await setup()
    for (const version of [undefined, '6.0.0', '6.0.1', '7.0.0']) {
      const response = await fetch(base + '/api/ask/bridge', { headers: {
        Authorization: `Bearer ${token}`, ...(version ? { 'X-Tinstar-Puller-Version': version } : {}),
      } })
      expect(response.status).toBe(200)
      expect(response.headers.get('X-Tinstar-Bridge-Contract')).toBe('1')
      expect(response.headers.get('X-Tinstar-Minimum-Puller-Version')).toBe('6.0.0')
      expect((await response.json()).data).toMatchObject({ contract_version: 1, minimum_puller_version: '6.0.0', pending: [], tracked: [] })
    }
  })

  it('rejects an obsolete or invalid client before GET or POST work', async () => {
    const { base, call } = await setup()
    const id = (await call('requests', input())).data.data.request_id
    for (const version of ['5.9.9', 'invalid']) {
      for (const method of ['GET', 'POST']) {
        const response = await fetch(base + '/api/ask/bridge', { method, headers: {
          Authorization: `Bearer ${token}`, 'X-Tinstar-Puller-Version': version, 'Content-Type': 'application/json',
        }, ...(method === 'POST' ? { body: JSON.stringify({ request_id: id, note: note(id) }) } : {}) })
        expect(response.status).toBe(426)
        expect((await response.json()).error).toMatchObject({ code: 'puller-upgrade-required', details: { minimum_puller_version: '6.0.0', contract_version: 1 } })
      }
    }
    expect((await call('requests')).data.data[0].status).toBe('sent')
  })

  it('serves packaged code and its digest only to authenticated pullers, including obsolete ones', async () => {
    const { base } = await setup()
    expect((await fetch(base + '/api/ask/bridge/puller')).status).toBe(401)
    const response = await fetch(base + '/api/ask/bridge/puller', { headers: {
      Authorization: `Bearer ${token}`, 'X-Tinstar-Puller-Version': '5.0.0',
    } })
    expect(response.status).toBe(200)
    const release = (await response.json()).data
    expect(release).toMatchObject({ version: JSON.parse(await readFile(resolve('package.json'), 'utf8')).version, bootstrap_api: 1 })
    expect(createHash('sha256').update(release.source).digest('hex')).toBe(release.sha256)
    expect(release.source).toBe(await readFile(resolve('scripts/ask-puller.py'), 'utf8'))
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const browser = await fetch(base + '/api/ask/bridge/puller', { headers: { Authorization: `Bearer ${token}`, Origin: base } })
    expect(browser.status).toBe(401)
  })
})

describe('6.0.0 bridge content compatibility', () => {
  const action = { id: 'continue', label: 'Continue', instruction: 'Investigate the outage' }
  const reference = { label: 'Evidence', url: 'https://example.test/evidence' }
  const content = { summary: 'An answer', detail: 'The evidence is retained.', references: [reference], suggested_actions: [] }
  it.each([
    { suggested_actions: [{ ...action, instruction: 'Open https://example.test' }] },
    { suggested_actions: [{ ...action, instruction: '`eval(source)`' }] },
    { suggested_actions: [{ ...action, instruction: 'First\nSecond' }] },
    { suggested_actions: [{ ...action, id: 'invalid id' }] },
    { suggested_actions: [{ ...action, label: 'x'.repeat(65) }] },
    { suggested_actions: [action, action] },
    { suggested_actions: Array.from({ length: 11 }, (_, index) => ({ ...action, id: `choice-${index}` })) },
    { suggested_actions: [{ ...action, execute: true }] },
    { suggested_actions: ['x'.repeat(2001)] },
    { suggested_actions: null },
    { references: [reference, { label: 'Unsafe', url: 'javascript:alert(1)' }, { url: 'https://example.test' }] },
    { references: Array.from({ length: 21 }, () => reference) },
    { references: 'invalid', summary: null, detail: { unexpected: true } },
    { summary: '', detail: null },
    { summary: 'x'.repeat(2001) },
  ])('accepts and persists degraded content without creating invalid buttons: %j', async invalid => {
    const { call, bridge, reload } = await setup()
    const id = (await call('requests', input())).data.data.request_id
    await bridge({ request_id: id, note: note(id) })
    const reply = { id: 'note-1', at: new Date().toISOString(), cursor: '000000000001',
      body: JSON.stringify({ schema: 'tinstar.ask-reply.v1', request_id: id, ...content, ...invalid }) }
    expect(await bridge({ request_id: id, reply })).toMatchObject({ status: 200, data: { ok: true, data: { accepted: true } } })
    reload()
    const saved = (await call('requests')).data.data[0]
    expect(saved).toMatchObject({ status: 'answered', error: null, reply: { degraded: true } })
    if (!('summary' in invalid)) expect(saved.reply.summary).toBe(content.summary)
    if (!('detail' in invalid)) expect(saved.reply.detail).toBe(content.detail)
    if (!('references' in invalid)) expect(saved.reply.references).toEqual([reference])
    if (Array.isArray(invalid.references) && invalid.references.length === 3) expect(saved.reply.references).toEqual([reference])
    expect(saved.reply.suggested_actions.every((value: unknown) => typeof value === 'string')).toBe(true)
    expect((await call('selections', { answer_id: id, action_id: action.id, client_key: randomUUID() })).status).toBe(404)
    expect((await bridge()).data.data.tracked).toEqual([])
    expect((await bridge({ request_id: id, reply })).status).toBe(200)
    expect((await bridge({ request_id: id, reply: { ...reply, cursor: '000000000002' } })).status).toBe(409)
  })

  it('runs the published puller through GET work and POST note, reply and error over HTTP', async () => {
    const { call, bridge, base, reload } = await setup()
    await publishedPullerContract({
      root, base, token, reload,
      create: async question => (await call('requests', { ...input(), question })).data.data.request_id,
      list: async () => (await call('requests')).data.data,
      work: async () => (await bridge()).data.data,
    })
  }, 30_000)
})

describe('suggested action rejection receipts', () => {
  it('keeps the valid action, returns each omitted action on retries, and sends those warnings in the next turn', async () => {
    const { call, bridge, reload } = await setup()
    const first = (await call('requests', input())).data.data
    await bridge({ request_id: first.request_id, note: note(first.request_id) })
    const actions = [
      { id: 'link', label: 'Read more', instruction: 'Open https://example.test' },
      { label: 'Missing ID', instruction: 'Recheck the card' },
      { id: 'valid', label: 'Recheck', instruction: 'Recheck (CI); keep v1.24.0' },
    ]
    const update = { request_id: first.request_id, reply: { id: 'note-1', at: new Date().toISOString(), cursor: '1',
      body: JSON.stringify({ schema: 'tinstar.ask-reply.v1', request_id: first.request_id,
        summary: 'Retained answer', detail: 'Retained evidence', references: [], suggested_actions: actions }) } }
    const receipt = await bridge(update)
    expect(receipt.status).toBe(200)
    const warnings = receipt.data.data.reply_warnings
    expect(warnings).toEqual([
      { index: 0, id: 'link', reason: expect.stringContaining('instruction: URLs and link syntax are not allowed') },
      { index: 1, reason: expect.stringContaining('id: Required') },
    ])
    reload()
    const saved = (await call('requests')).data.data[0]
    expect(saved.reply).toMatchObject({
      summary: 'Retained answer', detail: 'Retained evidence', degraded: true,
      suggested_actions: [{ id: 'valid', label: 'Recheck', instruction: 'Recheck (CI); keep v1.24.0' }],
      rejected_actions: warnings,
    })
    expect(JSON.parse(await readFile(join(root, 'ask-requests.json'), 'utf8'))[0].reply.rejected_actions).toEqual(warnings)
    expect((await bridge(update)).data.data.reply_warnings).toEqual(warnings)
    const conversation = (await call(`conversations/${first.conversation_id}`)).data.data
    expect(conversation.turns[1].reply.rejected_actions).toEqual(warnings)
    const next = (await call('requests', { ...input(), follow_up_to: first.request_id, question: 'Please revise these choices' })).data.data
    const pending = (await bridge()).data.data.pending.find((row: { request_id: string }) => row.request_id === next.request_id)
    expect(JSON.parse(pending.body.split('\n')[1]).conversation.turns[1].reply.rejected_actions).toEqual(warnings)
    expect((await bridge({ ...update, reply: { ...update.reply, cursor: '2' } })).status).toBe(409)
  })
})

describe('suggested merge targets', () => {
  it('stores a canonical pull URL, reports a malformed merge, and still selects an ordinary action', async () => {
    const { call, bridge, reload } = await setup()
    const first = (await call('requests', input())).data.data
    const merge = { id: 'merge-pr-7', label: 'Merge PR 7', instruction: 'Merge this pull request', merge: { pr_url: 'https://github.com/Owner/Repo/pull/7/' } }
    const bad = { id: 'merge-bad', label: 'Merge elsewhere', instruction: 'Merge the other pull request', merge: { pr_url: 'https://example.test/pull/1', head: 'a'.repeat(40) } }
    const keep = { id: 'keep-open', label: 'Keep open', instruction: 'Leave the pull request open' }
    const reply = { summary: 'Ready to merge', detail: 'One pull request is open.', references: [], suggested_actions: [bad, merge, keep] }
    expect((await bridge({ request_id: first.request_id, note: note(first.request_id) })).status).toBe(200)
    const receipt = await bridge({ request_id: first.request_id, reply: { id: 'note-1', at: new Date().toISOString(), cursor: '1', body: JSON.stringify({ schema: 'tinstar.ask-reply.v1', request_id: first.request_id, ...reply }) } })
    expect(receipt.status).toBe(200)
    expect(receipt.data.data.reply_warnings).toEqual([expect.objectContaining({ index: 0, id: 'merge-bad' })])
    reload()
    const saved = (await call('requests')).data.data[0]
    expect(saved.reply.suggested_actions).toEqual([{ ...merge, merge: { pr_url: 'https://github.com/owner/repo/pull/7' } }, keep])
    expect(saved.reply.rejected_actions).toEqual(receipt.data.data.reply_warnings)
    const selected = await call('selections', { answer_id: first.request_id, action_id: keep.id, client_key: randomUUID() })
    expect(selected.status).toBe(200)
    expect(selected.data.data).toMatchObject({ question: keep.instruction, action_selection: { action_id: keep.id, instruction: keep.instruction } })
    expect(JSON.stringify(selected.data.data.action_selection)).not.toContain('pr_url')
  })
})

describe('authenticated recommendation selections over the existing Ask bridge', () => {
  const close: AskAction = { id: 'close-done', label: 'Close as Done', instruction: 'Post the #3194 Feed verdict and set the linked Notion card Done' }
  const keep: AskAction = { id: 'keep-open', label: 'Keep open', instruction: 'Retain card until a real DEV stall exhibits Feed recovery.' }
  const reply = { summary: 'Why this is overdue', detail: 'The Feed verdict still needs confirmation.', references: [{ label: 'Evidence', url: 'https://example.test/evidence' }], suggested_actions: [close, keep, 'Legacy advice stays inert'] }
  const answer = async (bridge: Awaited<ReturnType<typeof setup>>['bridge'], requestId: string, noteId: string, value = reply) => {
    expect((await bridge({ request_id: requestId, note: note(requestId, noteId) })).status).toBe(200)
    expect((await bridge({ request_id: requestId, reply: { id: noteId, at: new Date().toISOString(), cursor: '1', body: JSON.stringify({ schema: 'tinstar.ask-reply.v1', request_id: requestId, ...value }) } })).status).toBe(200)
  }
  const payload = (body: string) => JSON.parse(body.split('\n')[1]!)

  it('retains typed v1 recommendations and dispatches only the authenticated saved selection with canonical context', async () => {
    const { call, bridge, reload } = await setup()
    const first = (await call('requests', { ...input(), question: 'Why is this overdue?', field_key: 'next_check_in', field_value: '2026-11-06T15:00:00Z' })).data.data
    await answer(bridge, first.request_id, 'overdue-note')
    reload()
    expect((await call('requests')).data.data[0].reply).toEqual(reply)
    const selectedInput = { answer_id: first.request_id, action_id: close.id, client_key: randomUUID() }
    const beforeClick = Date.now()
    const result = await call('selections', selectedInput)
    expect(result.status).toBe(200)
    const selected = result.data.data
    expect(selected).toMatchObject({ conversation_id: first.conversation_id, follow_up_to: first.request_id, status: 'sent', question: close.instruction, context: first.context,
      action_selection: { answer_id: first.request_id, action_id: close.id, label: close.label, instruction: close.instruction, actor: owner, selected_at: expect.any(String), selection_id: expect.any(String) } })
    expect(Date.parse(selected.action_selection.selected_at)).toBeGreaterThanOrEqual(beforeClick)
    expect(Date.parse(selected.action_selection.selected_at)).toBeLessThanOrEqual(Date.now())
    expect(selected.reply).toBeNull()
    for (const key of ['owner', 'client_key', 'client_key_aliases', 'dispatch_body', 'note_id']) expect(selected).not.toHaveProperty(key)
    const dispatched = (await bridge()).data.data.pending
    expect(dispatched).toHaveLength(1)
    const envelope = payload(dispatched[0].body)
    expect(envelope).toMatchObject({ schema: 'tinstar.ask.v1', request_id: selected.request_id, question: close.instruction, requesting_principal: owner, context: first.context, action_selection: selected.action_selection,
      conversation: { turns: [{ role: 'user', text: first.question }, { role: 'assistant', reply }] } })
    expect(dispatched[0].body).toContain('suggested_actions=[{id,label,instruction,merge?}]')
    expect(dispatched[0].body).toContain('Optional merge is exactly {"pr_url":"https://github.com/owner/repo/pull/1"}')
    expect(dispatched[0].body).toContain('no head SHA')
    for (const rule of ['at most 10', 'unique per-answer IDs of 1–64 ASCII letters/digits/underscore/hyphen starting with a letter/digit',
      'labels (1–64 characters)', 'instructions (1–2000 characters)', 'same text rules for both',
      `Normal punctuation is allowed: ( ) ' " = , : ; & + / # % ! ? and version numbers`, 'Instructions are never executed',
      'control characters', 'Unicode line/paragraph separators', 'backticks/code fences', 'HTML tags', 'URLs and link syntax', 'Put URLs only in references']) {
      expect(dispatched[0].body).toContain(rule)
    }
    expect(dispatched[0].body).toContain('recheck authoritative source state')
    expect(dispatched[0].body).toContain('Reconcile uncertain prior effects')
    expect(dispatched[0].inbox_request_id).toBe(inboxRequestId(selected.request_id))
  })

  it('rejects unauthenticated, foreign, invented and browser-authored selection content before any dispatch', async () => {
    const { call, bridge } = await setup()
    const first = (await call('requests', input())).data.data
    const click = { answer_id: first.request_id, action_id: close.id, client_key: randomUUID() }
    expect((await call('selections', click)).status).toBe(404) // unanswered
    await answer(bridge, first.request_id, 'auth-note')
    expect((await call('selections', click, {})).status).toBe(403)
    expect((await call('selections', click, { Authorization: `Bearer ${token}` })).status).toBe(403)
    expect((await call('selections', click, { 'Tailscale-User-Login': other, 'X-Tinstar-UI': '1' })).status).toBe(404)
    expect((await call('selections', click, { 'Tailscale-User-Login': owner, 'X-Tinstar-UI': '1', Origin: 'https://evil.test' })).status).toBe(403)
    for (const extra of [{ instruction: 'Forged instruction' }, { label: 'Forged label' }, { actor: other }, { selected_at: new Date().toISOString() }, { context: first.context }]) {
      expect((await call('selections', { ...click, ...extra })).status).toBe(400)
    }
    for (const change of [{ action_id: 'absent' }, { action_id: 'Legacy advice stays inert' }, { answer_id: randomUUID() }]) expect((await call('selections', { ...click, ...change })).status).toBe(404)
    expect((await call('selections', { ...click, client_key: 'invalid' })).status).toBe(400)
    expect((await call('selections')).status).toBe(404)
    expect((await bridge()).data.data.pending).toEqual([])
    expect((await call('requests')).data.data).toHaveLength(1)
  })

  it('converges retries and two devices on one frozen request, including after reply, reload and lost acknowledgement', async () => {
    const { call, bridge, reload } = await setup()
    const first = (await call('requests', input())).data.data
    await answer(bridge, first.request_id, 'race-note')
    const click = { answer_id: first.request_id, action_id: close.id, client_key: randomUUID() }
    const secondDevice = { ...click, client_key: randomUUID() }
    const clicks = await Promise.all([call('selections', click), call('selections', click), call('selections', secondDevice)])
    expect(clicks.map(result => result.status)).toEqual([200, 200, 200])
    const selected = clicks[0]!.data.data
    expect(new Set(clicks.map(result => result.data.data.request_id)).size).toBe(1)
    const before = (await bridge()).data.data.pending[0]
    expect((await call('selections', { ...click, action_id: keep.id, client_key: randomUUID() })).status).toBe(409)
    reload()
    expect((await call('selections', secondDevice)).data.data.request_id).toBe(selected.request_id)
    await call(`requests/${selected.request_id}/retry`, {})
    expect((await bridge()).data.data.pending).toEqual([before])
    await answer(bridge, selected.request_id, 'selection-result', { ...reply, summary: 'Blocked', detail: 'Blocked: the linked card cannot be updated with current access.', suggested_actions: [] })
    reload()
    for (const retry of [click, secondDevice, { ...click, client_key: randomUUID() }]) {
      expect((await call('selections', retry)).data.data).toMatchObject({ request_id: selected.request_id, status: 'answered', reply: { summary: 'Blocked' } })
    }
    expect((await call('selections', { ...secondDevice, answer_id: selected.request_id })).status).toBe(409)
    expect((await call('selections', { ...click, action_id: keep.id, client_key: randomUUID() })).status).toBe(409)
    const next = (await call('requests', { ...input(), question: 'Why is the regression test sufficient?', follow_up_to: selected.request_id })).data.data
    const history = payload((await bridge()).data.data.pending.find((row: { request_id: string }) => row.request_id === next.request_id).body).conversation.turns
    expect(history.map((turn: { role: string }) => turn.role)).toEqual(['user', 'assistant', 'action_selection', 'assistant'])
    expect(history[2]).toMatchObject({ selection: selected.action_selection, provenance: { source: 'operator_selection' } })
    expect(history[3].reply.summary).toBe('Blocked')
    expect((await call('requests')).data.data.filter((row: { action_selection?: unknown }) => row.action_selection)).toHaveLength(1)
  })

  it('accepts at most one of two competing device choices and sends only the winner', async () => {
    const { call, bridge } = await setup()
    const first = (await call('requests', input())).data.data
    await answer(bridge, first.request_id, 'conflict-note')
    const results = await Promise.all([close, keep].map(action => call('selections', { answer_id: first.request_id, action_id: action.id, client_key: randomUUID() })))
    expect(results.map(result => result.status).sort()).toEqual([200, 409])
    const winner = results.find(result => result.status === 200)!.data.data
    expect((await bridge()).data.data.pending.map((row: { request_id: string }) => row.request_id)).toEqual([winner.request_id])
  })

  it('retains the captured PR head and linked-card context when authoritative sources change before the click', async () => {
    const identity = { id: 'owner/repo#3194', repository: 'owner/repo', number: 3194, url: 'https://github.com/owner/repo/pull/3194' }
    const head = 'a'.repeat(40)
    const pulls: PullsRead = { pulls: [{ ...identity, head, title: 'Feed recovery', author: 'owner', draft: false, base: 'main', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-08T12:00:00.000Z', observedAt: '2026-11-08T12:00:00.000Z', freshness: 'fresh', links: [] }], repositories: [], warnings: [], associationsComplete: true }
    const read = vi.fn(async () => pulls)
    const relationships = { complete: true, cards: [{ card_id: fixtureId(1), sources: ['Notion GitHub property'] }], workers: [] }
    const { call, bridge } = await setup({ pulls: read, releases: async () => releaseAssociations(fixtureScene()), pullRelationships: async () => relationships })
    const first = (await call('requests', { client_key: randomUUID(), target: { kind: 'pull', id: identity.id, head }, question: 'Why is this overdue?', view: { scene: 'pulls' } })).data.data
    expect(first.context).toMatchObject({ source: { repository: identity.repository, number: 3194, head }, relationships })
    await answer(bridge, first.request_id, 'pr-context-note')
    pulls.pulls[0]!.head = 'b'.repeat(40)
    const selected = (await call('selections', { answer_id: first.request_id, action_id: close.id, client_key: randomUUID() })).data.data
    expect(selected.context).toEqual(first.context)
    expect(read).toHaveBeenCalledTimes(1)
    const envelope = payload((await bridge()).data.data.pending[0].body)
    expect(envelope.context.source.head).toBe(head)
    expect(envelope.context.relationships.cards[0].card_id).toBe(fixtureId(1))
    // First Mate receives the original snapshot and must recheck the new head;
    // this request records no repair, merge, card write or successful outcome.
    expect(selected.status).toBe('sent')
    expect(selected.reply).toBeNull()
  })

  it('rejects superseded recommendations and accepts the latest answer choices', async () => {
    const { call, bridge } = await setup()
    const first = (await call('requests', input())).data.data
    await answer(bridge, first.request_id, 'old-note')
    const next = (await call('requests', { ...input(), follow_up_to: first.request_id, question: 'Why is the regression test sufficient?' })).data.data
    await answer(bridge, next.request_id, 'new-note')
    const stale = await call('selections', { answer_id: first.request_id, action_id: close.id, client_key: randomUUID() })
    expect(stale.status).toBe(409)
    expect(stale.data.error.message).toContain('superseded')
    expect((await bridge()).data.data.pending).toEqual([])
    expect((await call('selections', { answer_id: next.request_id, action_id: keep.id, client_key: randomUUID() })).status).toBe(200)
  })

  it.each([
    { ...close, instruction: 'Open https://evil.test' }, { ...close, instruction: '`eval(source)`' },
    { ...close, execute: true }, { label: 'Missing ID', instruction: 'Close the card' },
  ])('degrades malformed recommendations without creating selectable actions: %j', async invalid => {
    const { call, bridge, reload } = await setup()
    const first = (await call('requests', input())).data.data
    await bridge({ request_id: first.request_id, note: note(first.request_id) })
    const update = (suggested_actions: unknown[]) => bridge({ request_id: first.request_id, reply: { id: 'note-1', at: new Date().toISOString(), cursor: '1', body: JSON.stringify({ schema: 'tinstar.ask-reply.v1', request_id: first.request_id, ...reply, suggested_actions }) } })
    expect((await update([invalid])).status).toBe(200)
    reload()
    expect((await call('requests')).data.data[0].reply).toMatchObject({ degraded: true, suggested_actions: [] })
    expect((await call('selections', { answer_id: first.request_id, action_id: close.id, client_key: randomUUID() })).status).toBe(404)
  })

  it('keeps GitHub references inert and dispatches one authenticated merge request only for a validated regenerated choice', async () => {
    const { call, bridge } = await setup()
    const first = (await call('requests', { ...input(), question: 'Give me one-click merge requests for these PRs.' })).data.data
    const references = [3359, 3365].map(number => ({ label: `Open PR ${number}`, url: `https://github.com/fortresspower/cmsandbox/pull/${number}` }))
    await answer(bridge, first.request_id, 'rejected-merges', { ...reply, references, suggested_actions: [
      { id: 'merge-3359', label: 'Request merge', instruction: `Request merge of ${references[0]!.url}` },
      { id: 'merge-3365', label: 'Request merge', instruction: `Request merge of ${references[1]!.url}` },
    ] })
    const rejected = (await call('requests')).data.data[0]
    expect(rejected.reply).toMatchObject({ references, suggested_actions: [], rejected_actions: [{ id: 'merge-3359' }, { id: 'merge-3365' }] })
    expect((await call('selections', { answer_id: first.request_id, action_id: 'merge-3359', client_key: randomUUID() })).status).toBe(404)
    expect((await bridge()).data.data.pending).toEqual([])
    const next = (await call('requests', { ...input(), question: 'Please resend the one-click choices for your last answer.', follow_up_to: first.request_id })).data.data
    const instruction = 'Request merging fortresspower/cmsandbox PR 3359 at its retained head through the existing authorized merge workflow.'
    await answer(bridge, next.request_id, 'regenerated-merges', { ...reply, references, suggested_actions: [{ id: 'merge-3359', label: 'Request merge', instruction }] })
    const click = { answer_id: next.request_id, action_id: 'merge-3359', client_key: randomUUID() }
    expect((await call('selections', click, {})).status).toBe(403)
    const results = await Promise.all([call('selections', click), call('selections', click)])
    const selected = results[0]!.data.data
    expect(results[1]!.data.data.request_id).toBe(selected.request_id)
    expect(selected).toMatchObject({ conversation_id: first.conversation_id, follow_up_to: next.request_id, status: 'sent', reply: null, action_selection: { answer_id: next.request_id, action_id: 'merge-3359', instruction, actor: owner } })
    const pending = (await bridge()).data.data.pending
    expect(pending).toHaveLength(1)
    expect(payload(pending[0].body)).toMatchObject({ request_id: selected.request_id, question: instruction, context: first.context })
    await bridge({ request_id: selected.request_id, note: note(selected.request_id, 'merge-request-delivered') })
    expect((await call('requests')).data.data.find((row: { request_id: string }) => row.request_id === selected.request_id)).toMatchObject({ status: 'delivered', reply: null })
    await answer(bridge, selected.request_id, 'merge-request-delivered', { ...reply, summary: 'Awaiting approval', detail: 'The required approving review is still missing. No merge was performed.', suggested_actions: [] })
    expect((await call('requests')).data.data.find((row: { request_id: string }) => row.request_id === selected.request_id)).toMatchObject({ status: 'answered', reply: { summary: 'Awaiting approval' } })
  })

  it('preserves legacy string suggestions as inert history', async () => {
    const { call, bridge, reload } = await setup()
    const first = (await call('requests', input())).data.data
    const suggestions = ['Legacy https://example.test', '<script>alert(1)</script>']
    await answer(bridge, first.request_id, 'legacy-note', { ...reply, suggested_actions: suggestions })
    reload()
    expect((await call('requests')).data.data[0].reply.suggested_actions).toEqual(suggestions)
    expect((await call('selections', { answer_id: first.request_id, action_id: close.id, client_key: randomUUID() })).status).toBe(404)
  })

  it.each([
    'Blocked: Admin Merge is disabled.', 'Blocked: the captured PR head changed. Recheck current CI.',
    'Blocked: Notion access is missing.', 'Blocked: the original source entity is missing.',
    'Unknown remote outcome. Reconcile the prior effect before retrying.',
  ])('retains First Mate permission/reconciliation reports as ordinary replies: %s', async detail => {
    const { call, bridge, reload } = await setup()
    const first = (await call('requests', input())).data.data
    await answer(bridge, first.request_id, 'gated-note')
    const selected = (await call('selections', { answer_id: first.request_id, action_id: close.id, client_key: randomUUID() })).data.data
    expect(selected.status).toBe('sent')
    expect(selected.reply).toBeNull()
    await bridge({ request_id: selected.request_id, note: note(selected.request_id, 'gated-result') })
    expect((await call('requests')).data.data.at(-1).status).toBe('delivered')
    await bridge({ request_id: selected.request_id, reply: { id: 'gated-result', at: new Date().toISOString(), cursor: '1', body: detail } })
    reload()
    const result = (await call('requests')).data.data.at(-1)
    expect(result).toMatchObject({ request_id: selected.request_id, status: 'answered', reply: { detail }, action_selection: { actor: owner, instruction: close.instruction } })
    expect(result).not.toHaveProperty('action_outcome')
  })
})

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

// Four puller processes plus the CLI, each starting Python against the loopback server.
it('runs scheduled Ask passes against the real Tin Star HTTP API with isolated inbox and clavis stand-ins', async () => {
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
    if not p.exists():
        p.write_text(json.dumps({'request_id':request,'body':body}))
        (home / 'dispatch.json').write_text(json.dumps({'notes':1,'wakes':1}))
    print(json.dumps({'schema':'fm-inbox-note.v1','outcome':'replay' if p.exists() else 'created','id':'proof-note','request_id':request,'saved':True,'announced':True,'acknowledged':False}))
elif sys.argv[1] == 'receipts':
    n = json.loads(p.read_text())
    reply = json.loads((home / 'reply.json').read_text()) if (home / 'reply.json').exists() else None
    print(json.dumps({'schema':'fm-inbox-receipts.v1','pending':[{'id':'proof-note','request_id':n['request_id'],'reply':reply}],'handled':[],'omitted':[]}))
`)
  await chmod(script, 0o700)
  // Import and call the executable pass: production CLI requires HTTPS, while
  // the isolated HTTP fixture binds only an ephemeral loopback listener.
  const driver = `import importlib.util,pathlib,sys\ns=importlib.util.spec_from_file_location('service',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nr=pathlib.Path(sys.argv[3])/'service';m.write_json(r/'ask-puller.json',{'enabled':True,'url':sys.argv[2],'home':sys.argv[3],'token_key':'test.ask','clavis':'clavis'})\nh=m.read_json(r/'ask-puller-health.json');print(m.tick(r,now=h.get('next_poll_at',0)))`
  const run = () => new Promise<string>((resolveRun, reject) => {
    execFile('python3', ['-c', driver, resolve('scripts/ask-puller-service.py'), base, home], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }, (error, stdout) => error ? reject(error) : resolveRun(stdout))
  })
  await run(); await run(); reload()
  expect((await call('requests')).data.data[0].status).toBe('delivered')
  expect(JSON.parse(await readFile(join(home, 'note.json'), 'utf8')).request_id).toBe(inboxRequestId(id))
  expect(JSON.parse(await readFile(join(home, 'dispatch.json'), 'utf8'))).toEqual({ notes: 1, wakes: 1 })
  await writeFile(join(home, 'reply.json'), JSON.stringify({ id: 'proof-note', at: new Date().toISOString(), body: 'Stand-in answer for adapter behavior only', cursor: '000000000001' }))
  await run(); await run(); reload()
  expect((await call('requests')).data.data).toMatchObject([{ request_id: id, status: 'answered', reply: { detail: 'Stand-in answer for adapter behavior only' } }])
  expect(JSON.parse(await readFile(join(home, 'service', 'ask-puller-health.json'), 'utf8'))).toMatchObject({ work_polls: 2, noop_polls: 2, captured: 1, replied: 1, queued: 0 })
  const cli = await exec('python3', ['scripts/ask-puller.py', '--url', base, '--home', home, '--token-key', 'test.ask'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).catch(error => error)
  expect(cli.stderr).toContain('must be an HTTPS origin')
}, 30_000)

it('checks the standalone puller CLI security and retry behavior', async () => {
  const result = await exec('python3', ['-m', 'unittest', 'discover', '-s', 'scripts/tests', '-p', 'test_ask_puller*.py'])
  expect(result.stderr).toContain('OK')
  // The deadline cases hold past a spawn-sized budget. Under suite load that budget is several seconds, twice.
}, 90_000)

it('persists semantic fields, exact worker identities and server-resolved relationship provenance on the existing Ask path', async () => {
  const { call, bridge, reload } = await setup()
  const scene = fixtureScene(), claim = scene.claims.find(claim => claim.cardId === fixtureId(1))!, worker = scene.executions[0]!
  const status = await call('requests', { ...input(), field_key: 'status', field_value: 'In Progress' })
  expect(status.status).toBe(200)
  expect(status.data.data.context).toMatchObject({ anchor: { kind: 'work', page_id: fixtureId(1) }, field_key: 'status', field_value: 'In Progress' })
  const workerInput = { client_key: randomUUID(), target: { kind: 'execution', id: worker.id }, question: 'What is this worker doing?', view }
  const first = await call('requests', workerInput)
  expect(first.status).toBe(200)
  expect(first.data.data.context).toMatchObject({ anchor: { kind: 'worker', page_id: worker.id }, target: workerInput.target })
  const relationshipInput = { client_key: randomUUID(), target: { kind: 'claim', id: claim.id }, question: 'How are these two items related?', field_key: 'relationship', field_value: claim.id, view }
  const link = await call('requests', relationshipInput)
  expect(link.status).toBe(200)
  expect(link.data.data.context).toMatchObject({ anchor: { kind: 'link', page_id: claim.cardId }, target: relationshipInput.target, relationship: { claim_id: claim.id, card_id: claim.cardId, execution_id: claim.executionId, sources: claim.sources, basis: claim.basis, verification: claim.verification } })
  reload()
  expect((await call('requests', relationshipInput)).data.data.request_id).toBe(link.data.data.request_id)
  expect((await call('requests', { ...relationshipInput, target: { kind: 'execution', id: worker.id } })).status).toBe(409)
  expect((await call('requests', { ...relationshipInput, field_value: 'different' })).status).toBe(409)
  expect((await call('requests', { ...workerInput, client_key: randomUUID(), target: { kind: 'execution', id: 'unknown' } })).status).toBe(404)
  expect((await call('requests', { ...relationshipInput, client_key: randomUUID(), relationship: { card_id: fixtureId(99) } })).status).toBe(400)
  expect((await bridge()).data.data.pending).toHaveLength(3)
  const id = link.data.data.request_id
  await bridge({ request_id: id, note: note(id) })
  await bridge({ request_id: id, reply: { id: 'note-1', at: new Date().toISOString(), body: 'Verified the two real endpoints.', cursor: '1' } })
  reload()
  const retained = (await call('requests')).data.data.find((item: { request_id: string }) => item.request_id === id)
  expect(retained).toMatchObject({ status: 'answered', context: { target: relationshipInput.target, relationship: { card_id: claim.cardId, execution_id: claim.executionId } } })
  const followInput = { ...relationshipInput, client_key: randomUUID(), follow_up_to: id, question: 'What changed?', field_key: undefined, field_value: undefined }
  const follow = await call('requests', followInput)
  expect(follow.data.data.conversation_id).toBe(id)
  expect(follow.data.data.context).toEqual(retained.context)
  reload()
  expect((await call('requests', followInput)).data.data.request_id).toBe(follow.data.data.request_id)
})

it('resolves typed PR/deployment/receipt origins from the shared projections, persists them and retains existing callbacks', async () => {
  const releases = releaseAssociations(fixtureScene())
  const identity = { id: 'owner/repo#17', repository: 'owner/repo', number: 17, url: 'https://github.com/owner/repo/pull/17' }
  const head = 'a'.repeat(40)
  const receipt = { id: 'immutable-receipt-1', repository: identity.repository, environment: 'production', target: 'production', component: 'web', deployedSha: 'b'.repeat(40), artifactDigest: null, version: '6.0', deployedAt: '2026-11-08T12:00:00.000Z', workflowUrl: 'https://github.com/owner/repo/actions/runs/55', receiptUrl: 'https://github.com/owner/repo/releases/tag/v6', outcome: 'succeeded' as const, exceptions: [] }
  releases.pulls = [{ ...identity, title: 'Authoritative release title', head, state: 'merged', mergeSha: 'b'.repeat(40), mergedAt: '2026-11-08T11:00:00.000Z', observedAt: '2026-11-08T12:00:00.000Z', freshness: 'fresh', links: [], exceptions: [], deployment: { state: 'shipped', targets: [{ target: 'production', component: 'web', state: 'live', reason: 'Verified receipt', ancestry: 'ancestor', receipt }] } }]
  const pulls: PullsRead = { pulls: [{ ...identity, head, title: 'Authoritative PR title', author: 'owner', draft: false, base: 'main', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-08T12:00:00.000Z', observedAt: '2026-11-08T12:00:00.000Z', freshness: 'fresh', links: [] }], repositories: [], warnings: [], associationsComplete: true }
  let reads = 0
  const relationships = { complete: true, cards: [{ card_id: fixtureId(1), sources: ['Notion Link/GitHub property'] }], workers: [] }
  const { call, bridge, reload } = await setup({ pulls: async () => { reads++; return pulls }, releases: async () => { reads++; return releases }, pullRelationships: async () => relationships })
  await new AskStore(root).create(owner, randomUUID(), 'Legacy stored question', context())
  const prInput = { client_key: randomUUID(), target: { kind: 'pull', id: identity.id, head }, question: 'Why is CI pending?', field_key: 'ci', field_value: 'Captured UI hint', view: { scene: 'pulls', query: 'pending', sort: 'repository' } }
  const pr = await call('requests', prInput)
  expect(pr.status).toBe(200)
  expect(pr.data.data.context).toMatchObject({ schema_version: 2, anchor: { kind: 'pull', page_id: identity.id, label: 'owner/repo#17 · Authoritative PR title', url: identity.url }, target: prInput.target, source: { kind: 'github', repository: identity.repository, number: 17, head }, return_to: { section: 'pulls', target: prInput.target }, field_key: 'ci' })
  expect(pr.data.data.context.relationships).toEqual(relationships)
  expect((await call('requests', { ...prInput, client_key: randomUUID(), relationships: { complete: true, cards: [], workers: [] } })).status).toBe(400)
  const releaseInput = { ...prInput, client_key: randomUUID(), target: { kind: 'release', id: identity.id, target: 'production', component: 'web' }, view: { scene: 'releases', filter: 'Shipped' }, field_key: 'deployment' }
  const deployed = await call('requests', releaseInput)
  expect(deployed.status).toBe(200)
  expect(deployed.data.data.context).toMatchObject({ anchor: { kind: 'release' }, source: { kind: 'deployment', target: 'production', component: 'web', receipt_id: receipt.id, deployed_sha: receipt.deployedSha }, return_to: { section: 'releases', target: releaseInput.target } })
  const receiptInput = { ...releaseInput, client_key: randomUUID(), target: { ...releaseInput.target, kind: 'receipt', receipt_id: receipt.id }, field_key: 'receipt' }
  expect((await call('requests', { ...receiptInput, client_key: randomUUID(), target: { ...receiptInput.target, receipt_id: 'superseded-receipt' } })).status).toBe(404)
  expect((await call('requests', { ...releaseInput, client_key: randomUUID(), target: { ...releaseInput.target, component: 'invented' } })).status).toBe(404)
  const saved = await call('requests', receiptInput)
  expect(saved.status).toBe(200)
  expect(saved.data.data.context).toMatchObject({ anchor: { kind: 'receipt', url: receipt.receiptUrl }, source: { receipt_id: receipt.id, receipt_url: receipt.receiptUrl, workflow_url: receipt.workflowUrl } })
  reload()
  const before = reads
  pulls.pulls = []; releases.pulls = []
  expect((await call('requests', prInput)).data.data.request_id).toBe(pr.data.data.request_id)
  expect(reads).toBe(before)
  expect((await call('requests', { ...prInput, target: { ...prInput.target, head: 'c'.repeat(40) } })).status).toBe(409)
  expect((await call('requests', { ...receiptInput, client_key: randomUUID() })).status).toBe(404)
  const id = saved.data.data.request_id
  await bridge({ request_id: id, note: note(id) })
  await bridge({ request_id: id, reply: { id: 'note-1', at: new Date().toISOString(), body: 'Typed artifact reply via existing bridge.', cursor: '1' } })
  const retained = (await call('requests')).data.data.find((item: { request_id: string }) => item.request_id === id)
  expect(retained.status).toBe('answered')
  const legacy = (await call('requests')).data.data.find((row: { question: string }) => row.question === 'Legacy stored question')
  expect(legacy.context).toEqual(context())
  expect(legacy.context.schema_version).toBeUndefined()
  const follow = await call('requests', { ...receiptInput, client_key: randomUUID(), follow_up_to: id, field_key: undefined, field_value: undefined, question: 'What changed?' })
  expect(follow.data.data.context).toEqual(retained.context)
  expect(follow.data.data.conversation_id).toBe(id)
})

it('rejects invented artifact locators, unavailable scope and foreign owners without accepting client provenance', async () => {
  const { call } = await setup({ pulls: async () => ({ pulls: [], repositories: [], warnings: [], associationsComplete: true }), releases: async () => releaseAssociations(fixtureScene()) })
  const body = { client_key: randomUUID(), target: { kind: 'pull', id: 'owner/repo#999', head: 'a'.repeat(40) }, question: 'Why?', view: { scene: 'pulls' } }
  expect((await call('requests', body)).status).toBe(404)
  expect((await call('requests', { ...body, return_to: { section: 'pulls', target: body.target } })).status).toBe(400)
  expect((await call('requests', { ...body, source: { kind: 'github' } })).status).toBe(400)
  expect((await call('requests', body, { 'Tailscale-User-Login': 'stranger', 'X-Tinstar-UI': '1' })).status).toBe(403)
  expect((await call('requests', { ...body, target: { kind: 'pull', id: 'https://evil.test/#1' } })).status).toBe(400)
})

it('anchors a closed PR resolved on demand and retains captured versus current heads through retry', async () => {
  const identity = { id: 'owner/repo#17', repository: 'owner/repo', number: 17, url: 'https://github.com/owner/repo/pull/17' }, head = 'b'.repeat(40)
  const origin = vi.fn(async () => ({ ...identity, state: 'merged' as const, title: 'Now merged', author: 'owner', draft: false, head, base: 'main', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-08T12:00:00Z', observedAt: '2026-11-08T12:00:00Z', freshness: 'fresh' as const, links: [] }))
  const { call, reload } = await setup({ pulls: async () => ({ pulls: [], repositories: [], warnings: [], associationsComplete: true }), releases: async () => releaseAssociations(fixtureScene()), pullOrigin: origin })
  const body = { client_key: randomUUID(), target: { kind: 'pull', id: identity.id, head: 'a'.repeat(40) }, question: 'What changed after this question?', view: { scene: 'pulls', query: 'kept filter' } }
  const saved = await call('requests', body)
  expect(saved.status).toBe(200)
  expect(saved.data.data.context).toMatchObject({ target: body.target, source: { head }, return_to: { target: body.target, view: body.view } })
  expect(origin).toHaveBeenCalledWith(identity.url)
  reload()
  expect((await call('requests', body)).data.data.request_id).toBe(saved.data.data.request_id)
  expect(origin).toHaveBeenCalledTimes(1)
})

it('retains exact element context in the existing bridge, retry and follow-up protocol', async () => {
  const { call, bridge, reload } = await setup()
  const element = { field_name: 'next_check_in', label: 'Overdue 3d · Next check-in Nov 6, 10:00 AM ET', value: '2026-11-06T15:00:00Z', type: 'overdue' }
  const body = { ...input(), field_key: 'next_check_in', field_value: element.value, element }
  const first = await call('requests', body), id = first.data.data.request_id
  expect(first.status).toBe(200)
  expect(first.data.data.context).toMatchObject({ element, return_to: { section: 'overview', target: { kind: 'card', id: fixtureId(1) } } })
  const pending = (await bridge()).data.data.pending[0]
  expect(pending.body).toContain(JSON.stringify(element))
  expect(JSON.parse(pending.body.split('\n')[1]).context.element).toEqual(element)
  reload()
  expect((await call('requests', body)).data.data.request_id).toBe(id)
  expect((await call('requests', { ...body, element: { ...element, label: 'Different field' } })).status).toBe(409)
  const follow = await call('requests', { ...input(), follow_up_to: id })
  expect(follow.data.data).toMatchObject({ conversation_id: id, context: { element } })
})

it('persists Desk selections separately from the source across retry and history', async () => {
  const { call, bridge, reload } = await setup()
  const first = (await call('requests', input())).data.data
  const element = { field_name: 'answer', label: 'First Mate answer', value: 'Wait for review', type: 'generic' }
  const selection = { element, field_key: 'description', field_value: element.value }
  const body = { ...input(), ...selection, follow_up_to: first.request_id, question: 'What does this mean and what needs attention?' }
  const selected = (await call('requests', body)).data.data
  expect(selected).toMatchObject({ context: first.context, captured_selection: selection })
  const payload = () => bridge().then(result => JSON.parse(result.data.data.pending.find((row: { request_id: string }) => row.request_id === selected.request_id).body.split('\n')[1]))
  expect(await payload()).toMatchObject({ question: body.question, captured_selection: selection, context: first.context })
  reload()
  expect((await call('requests', body)).data.data.request_id).toBe(selected.request_id)
  expect((await call('requests', { ...body, element: { ...element, value: 'Different advice' } })).status).toBe(409)
  const next = (await call('requests', { ...input(), follow_up_to: selected.request_id })).data.data
  expect(next.captured_selection).toBeUndefined()
  const pending = (await bridge()).data.data.pending.find((row: { request_id: string }) => row.request_id === next.request_id)
  expect(JSON.parse(pending.body.split('\n')[1]).conversation.turns).toContainEqual(expect.objectContaining({ request_id: selected.request_id, role: 'user', captured_selection: selection }))
  const history = (await call('conversations/' + first.conversation_id)).data.data
  expect(history.turns).toContainEqual(expect.objectContaining({ request_id: selected.request_id, captured_selection: selection }))
})

describe('actual conversation history delivered through the existing bridge', () => {
  const envelope = (body: string) => JSON.parse(body.split('\n')[1]!)
  const answer = async (bridge: Awaited<ReturnType<typeof setup>>['bridge'], id: string, index: number, detail = 'The Feed change needs a fresh review.') => {
    const reply = { summary: `Answer ${index}`, detail, references: [{ label: 'Feed PR evidence', url: 'https://github.com/except-pass/tinstar/pull/3194' }], suggested_actions: ['Check the review'] }
    await bridge({ request_id: id, note: note(id, `thread-note-${index}`) })
    expect((await bridge({ request_id: id, reply: { id: `thread-note-${index}`, at: new Date().toISOString(), body: JSON.stringify({ schema: 'tinstar.ask-reply.v1', request_id: id, ...reply }), cursor: String(index) } })).status).toBe(200)
    return reply
  }
  it('delivers three ordered turns with sources, exact parent IDs, literal pronouns and no other owner/conversation', async () => {
    const { call, bridge, reload } = await setup()
    const first = (await call('requests', { ...input(), question: 'What blocks the Feed PR?' })).data.data
    const reply = await answer(bridge, first.request_id, 1)
    await call('requests', { ...input(), question: 'An independent secret' })
    await call('requests', { ...input(), question: 'Another owner secret' }, { 'Tailscale-User-Login': other, 'X-Tinstar-UI': '1' })
    const secondInput = { ...input(), question: 'Can it proceed now?', follow_up_to: first.request_id }
    const second = (await call('requests', secondInput)).data.data
    expect(second).toMatchObject({ conversation_id: first.conversation_id, follow_up_to: first.request_id })
    let payload = envelope((await bridge()).data.data.pending.find((row: { request_id: string }) => row.request_id === second.request_id).body)
    expect(payload).toMatchObject({ schema: 'tinstar.ask.v1', request_id: second.request_id, conversation_id: first.conversation_id, follow_up_to: first.request_id, question: 'Can it proceed now?', context: first.context,
      conversation: { omitted: null, turns: [
        { role: 'user', request_id: first.request_id, text: first.question, at: first.created_at, provenance: { source: 'owner_input' } },
        { role: 'assistant', request_id: first.request_id, reply, provenance: { source: 'fm_inbox_reply', note_id: 'thread-note-1', cursor: '1' } },
      ] },
    })
    const secondReply = await answer(bridge, second.request_id, 2, 'It still needs that review.')
    reload()
    expect((await call('requests', secondInput)).data.data.request_id).toBe(second.request_id)
    const third = (await call('requests', { ...input(), question: 'Who can give it?', follow_up_to: second.request_id })).data.data
    payload = envelope((await bridge()).data.data.pending.find((row: { request_id: string }) => row.request_id === third.request_id).body)
    expect(payload.question).toBe('Who can give it?')
    expect(payload.conversation.turns.map((turn: { role: string }) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(payload.conversation.turns[3].reply).toEqual(secondReply)
    expect(JSON.stringify(payload)).not.toMatch(/independent secret|owner secret/)
    reload()
    const history = (await call(`conversations/${first.conversation_id}`)).data.data
    expect(history.turns.filter((turn: { role: string }) => turn.role === 'user').map((turn: { text: string }) => turn.text)).toEqual([first.question, second.question, third.question])
    expect(history.omitted).toBeNull()
    expect((await call(`conversations/${first.conversation_id}`, undefined, { 'Tailscale-User-Login': other, 'X-Tinstar-UI': '1' })).status).toBe(404)
    expect((await call(`requests`, { ...input(), follow_up_to: first.request_id }, { 'Tailscale-User-Login': other, 'X-Tinstar-UI': '1' })).status).toBe(404)
    expect((await call(`conversations/${first.conversation_id}`, undefined, {})).status).toBe(403)
    expect((await bridge()).data.data.pending[0]).not.toHaveProperty('dispatch_body')
  })
  it('freezes the emitted note over lost acknowledgments, late replies, future turns and reloads', async () => {
    const { call, bridge, reload } = await setup()
    const first = (await call('requests', input())).data.data
    const followInput = { ...input(), follow_up_to: first.request_id, question: 'And what about it?' }
    const second = (await call('requests', followInput)).data.data
    const initial = (await bridge()).data.data.pending.find((row: { request_id: string }) => row.request_id === second.request_id)
    await answer(bridge, first.request_id, 1, 'A later answer, unavailable when the follow-up was sent.')
    await call('requests', { ...input(), follow_up_to: second.request_id, question: 'A future question' })
    await call(`requests/${second.request_id}/retry`, {})
    reload()
    const retried = (await bridge()).data.data.pending.find((row: { request_id: string }) => row.request_id === second.request_id)
    expect(retried).toEqual(initial)
    expect(envelope(retried.body).conversation.turns).toHaveLength(1)
    expect((await call('requests', { ...followInput, follow_up_to: undefined })).status).toBe(409)
    expect((await call('requests')).data.data[0]).not.toHaveProperty('dispatch_body')
  })
  it('labels omitted complete turns and retrieves the full transcript through both authenticated APIs', async () => {
    const { call, bridge, reload } = await setup()
    const first = (await call('requests', input())).data.data
    await answer(bridge, first.request_id, 1, '漢'.repeat(16000))
    const second = (await call('requests', { ...input(), question: 'What about that?', follow_up_to: first.request_id })).data.data
    await answer(bridge, second.request_id, 2)
    const third = (await call('requests', { ...input(), question: 'What next?', follow_up_to: second.request_id })).data.data
    const payload = envelope((await bridge()).data.data.pending[0].body)
    expect(payload.request_id).toBe(third.request_id)
    expect(payload.conversation.omitted).toMatchObject({ count: 2, reason: 'history_byte_budget', first: { id: `${first.request_id}:user` }, last: { id: `${first.request_id}:assistant` } })
    expect(payload.conversation.turns.map((turn: { request_id: string }) => turn.request_id)).toEqual([second.request_id, second.request_id])
    reload()
    const full = (await bridge()).data.data.pending[0].body
    expect(envelope(full).conversation.omitted).toEqual(payload.conversation.omitted)
    const browser = (await call(`conversations/${first.conversation_id}`)).data.data
    const fetched = (await call(`bridge?conversation_id=${first.conversation_id}`, undefined, { Authorization: `Bearer ${token}` })).data.data
    expect(fetched).toEqual(browser)
    expect(fetched.turns).toHaveLength(5)
    expect(fetched.turns[1].reply.detail).toBe('漢'.repeat(16000))
    expect((await call(`bridge?conversation_id=${first.conversation_id}`, undefined, { Authorization: 'Bearer wrong' })).status).toBe(401)
  })
  it('projects legacy records and freezes their first delivery without migrating away replies or parent context', async () => {
    root = await mkdtemp(join(tmpdir(), 'tinstar-legacy-thread-'))
    const original = new AskStore(root, () => '2026-11-09T15:00:00.000Z')
    const first = await original.create(owner, randomUUID(), 'Legacy question', context())
    await original.ingest({ request_id: first.request_id, note: note(first.request_id) })
    await original.ingest({ request_id: first.request_id, reply: { id: 'note-1', at: first.created_at, cursor: '1', body: 'Legacy answer' } })
    const second = await original.create(owner, randomUUID(), 'Legacy follow-up', context(), first.request_id)
    const rows = JSON.parse(await readFile(join(root, 'ask-requests.json'), 'utf8'))
    for (const row of rows) { delete row.follow_up_to; delete row.dispatch_body; delete row.answered_at }
    await writeFile(join(root, 'ask-requests.json'), JSON.stringify(rows))
    const legacy = new AskStore(root)
    const body = (await legacy.bridgeWork()).pending[0]!.body
    expect(envelope(body).conversation.turns.map((turn: { role: string }) => turn.role)).toEqual(['user', 'assistant'])
    expect(envelope(body).conversation.turns[1].reply.detail).toBe('Legacy answer')
    expect((await legacy.create(owner, second.client_key, second.question, context(), first.request_id)).request_id).toBe(second.request_id)
    expect((await new AskStore(root).bridgeWork()).pending[0]!.body).toBe(body)
  })
  it('delivers operator selections as durable requests and uses the normal First Mate reply as their outcome', async () => {
    root = await mkdtemp(join(tmpdir(), 'tinstar-selected-request-'))
    const store = new AskStore(root, () => '2026-11-09T15:00:00.000Z')
    const first = await store.create(owner, randomUUID(), 'What can we do?', context())
    await store.ingest({ request_id: first.request_id, note: note(first.request_id) })
    await store.ingest({ request_id: first.request_id, reply: { id: 'note-1', at: first.created_at, cursor: '1', body: 'Check the review.' } })
    // Chunk 2 supplies lookup from typed actions; this fixture maps a stored
    // answer to a canonical recommendation without exposing a selection route.
    const lookup = (answer: typeof first, actionId: string) => answer.reply?.detail === 'Check the review.' && actionId === 'check-review' ? { id: actionId, label: 'Check review', instruction: 'Please check the Feed PR review.' } : undefined
    const input = { answer_id: first.request_id, action_id: 'check-review', client_key: randomUUID() }
    const secondDevice = { ...input, client_key: randomUUID() }
    const [selected, sameAction] = await Promise.all([store.createActionSelection(owner, input, lookup), store.createActionSelection(owner, secondDevice, lookup)])
    expect(sameAction.request_id).toBe(selected.request_id)
    expect(selected).toMatchObject({ conversation_id: first.conversation_id, follow_up_to: first.request_id, status: 'sent', question: 'Please check the Feed PR review.',
      action_selection: { answer_id: first.request_id, action_id: 'check-review', actor: owner, label: 'Check review', instruction: 'Please check the Feed PR review.', selected_at: first.created_at } })
    expect(selected.action_selection!.selection_id).toMatch(/^[a-f0-9-]{36}$/)
    const body = (await store.bridgeWork()).pending[0]!
    expect(body.inbox_request_id).toBe(inboxRequestId(selected.request_id))
    expect(envelope(body.body)).toMatchObject({ request_id: selected.request_id, question: selected.question, action_selection: selected.action_selection, conversation: { turns: [{ role: 'user' }, { role: 'assistant' }] } })
    await store.ingest({ request_id: selected.request_id, note: note(selected.request_id, 'selected-note') })
    const reply = { id: 'selected-note', at: first.created_at, cursor: '2', body: 'I checked it: review is still pending.' }
    await store.ingest({ request_id: selected.request_id, reply })
    await store.ingest({ request_id: selected.request_id, reply })
    const reloaded = new AskStore(root)
    // Replay precedes supersession by the selected request's newer reply.
    expect((await reloaded.createActionSelection(owner, input, lookup)).request_id).toBe(selected.request_id)
    expect((await reloaded.createActionSelection(owner, secondDevice, lookup)).request_id).toBe(selected.request_id)
    await expect(reloaded.createActionSelection(owner, { ...secondDevice, answer_id: selected.request_id }, lookup)).rejects.toThrow('Retry key')
    expect((await reloaded.createActionSelection(owner, { ...input, client_key: randomUUID() }, lookup)).request_id).toBe(selected.request_id)
    await expect(reloaded.createActionSelection(owner, { ...input, action_id: 'competing-action' }, lookup)).rejects.toThrow('Retry key')
    await expect(reloaded.createActionSelection(owner, { ...input, action_id: 'competing-action', client_key: randomUUID() }, lookup)).rejects.toThrow('already selected')
    await expect(reloaded.create(owner, input.client_key, selected.question, context(), first.request_id)).rejects.toThrow('Retry key')
    const next = await reloaded.create(owner, randomUUID(), 'Did it work?', context(), selected.request_id)
    const nextPayload = envelope((await reloaded.bridgeWork()).pending.find(row => row.request_id === next.request_id)!.body)
    expect(nextPayload.conversation.turns.map((turn: { role: string }) => turn.role)).toEqual(['user', 'assistant', 'action_selection', 'assistant'])
    expect(nextPayload.conversation.turns[2]).toMatchObject({ request_id: selected.request_id, selection: selected.action_selection, provenance: { source: 'operator_selection' } })
    expect(nextPayload.conversation.turns[3].reply.detail).toBe(reply.body)
    expect((await reloaded.list(owner)).filter(row => row.action_selection)).toHaveLength(1)
  })
  it('rejects foreign/unanswered actions, forged selection content and superseded recommendations atomically', async () => {
    root = await mkdtemp(join(tmpdir(), 'tinstar-stale-selection-'))
    const store = new AskStore(root, () => '2026-11-09T15:00:00.000Z')
    const first = await store.create(owner, randomUUID(), 'Question', context())
    const lookup = vi.fn((_answer: typeof first, actionId: string) => actionId === 'canonical' ? { id: actionId, label: 'Canonical action', instruction: 'Canonical saved instruction' } : undefined)
    const input = { answer_id: first.request_id, action_id: 'canonical', client_key: randomUUID() }
    await expect(store.createActionSelection(owner, input, lookup)).rejects.toThrow('unavailable')
    await expect(store.createActionSelection(other, input, lookup)).rejects.toThrow('unavailable')
    expect(() => store.createActionSelection(owner, { ...input, instruction: 'Forged' } as typeof input, lookup)).toThrow()
    await store.ingest({ request_id: first.request_id, note: note(first.request_id) })
    await store.ingest({ request_id: first.request_id, reply: { id: 'note-1', at: first.created_at, cursor: '1', body: 'First answer' } })
    await expect(store.createActionSelection(owner, { ...input, action_id: 'absent' }, lookup)).rejects.toThrow('saved answer')
    const second = await store.create(owner, randomUUID(), 'Follow-up', context(), first.request_id)
    await store.ingest({ request_id: second.request_id, note: note(second.request_id, 'note-2') })
    await store.ingest({ request_id: second.request_id, reply: { id: 'note-2', at: first.created_at, cursor: '2', body: 'New answer' } })
    lookup.mockClear()
    await expect(store.createActionSelection(owner, input, lookup)).rejects.toThrow('superseded')
    expect(lookup).not.toHaveBeenCalled()
    expect((await store.list(owner)).filter(row => row.action_selection)).toHaveLength(0)
  })
  it('bounds escaped Unicode history, large view state and pending batches for the installed Mac puller', async () => {
    root = await mkdtemp(join(tmpdir(), 'tinstar-bounded-thread-'))
    const store = new AskStore(root)
    const large = context(); large.view.collapsed = Array.from({ length: 500 }, () => '漢'.repeat(2048))
    const first = await store.create(owner, randomUUID(), '\u0000'.repeat(4000), large)
    const rows = [first, ...Array.from({ length: 54 }, () => {
      const id = randomUUID()
      return { ...first, request_id: id, conversation_id: id, client_key: randomUUID(), context: context(), dispatch_body: undefined }
    })]
    await writeFile(join(root, 'ask-requests.json'), JSON.stringify(rows))
    const work = await new AskStore(root).bridgeWork()
    expect(Buffer.byteLength(JSON.stringify(work))).toBeLessThan(2 * 1024 * 1024)
    expect(work.pending.length).toBeLessThan(50)
    const payload = envelope(work.pending[0]!.body)
    expect(payload.context.anchor).toEqual(large.anchor)
    expect(payload.context_omitted).toContain('view.collapsed')
    expect(payload.question).toBe('\u0000'.repeat(4000))
    expect(Buffer.byteLength(work.pending[0]!.body)).toBeLessThan(96 * 1024)
  })
})

describe('deploy smoke partition', () => {
  it('round trips on the real owner/bridge routes while hiding pending, tracked and answered smoke rows across reload', async () => {
    const { call, bridge, reload, base } = await setup()
    const syntheticId = randomUUID(), secondId = randomUUID()
    const auth = { Authorization: `Bearer ${token}` }
    const ownerAuth = { ...auth, 'Tailscale-User-Login': owner, 'X-Tinstar-UI': '1' }
    const smoke = { ...input(), card_id: '00000000000000000000000000000000', synthetic_id: syntheticId }
    expect((await call('requests', smoke)).status).toBe(403)
    expect((await call('requests', smoke, auth)).status).toBe(403)
    const regular = (await call('requests', input())).data.data
    const created = await call('requests', smoke, ownerAuth)
    expect(created.status).toBe(200)
    const row = created.data.data
    expect(row).not.toHaveProperty('synthetic_id')
    const scoped = (id = syntheticId, body?: unknown) => call(`bridge?synthetic_id=${id}`, body, auth)
    reload()
    expect((await call('requests')).data.data.map((r: { request_id: string }) => r.request_id)).toEqual([regular.request_id])
    expect((await bridge()).data.data.pending.map((r: { request_id: string }) => r.request_id)).toEqual([regular.request_id])
    expect((await scoped()).data.data.pending.map((r: { request_id: string }) => r.request_id)).toEqual([row.request_id])
    expect((await scoped(secondId)).data.data).toMatchObject({ pending: [], tracked: [] })
    expect((await bridge({ request_id: row.request_id, note: note(row.request_id) })).status).toBe(404)
    expect((await scoped(syntheticId, { request_id: regular.request_id, note: note(regular.request_id) })).status).toBe(404)
    expect((await scoped(syntheticId, { request_id: row.request_id, note: note(row.request_id) })).status).toBe(200)
    expect((await bridge()).data.data.tracked).toEqual([])
    expect((await scoped()).data.data.tracked).toHaveLength(1)
    const update = { request_id: row.request_id, reply: { id: 'note-1', at: new Date().toISOString(), body: 'Synthetic answer', cursor: '1' } }
    expect((await scoped(secondId, update)).status).toBe(404)
    expect((await scoped(syntheticId, update)).status).toBe(200)
    reload()
    expect((await call(`conversations/${row.conversation_id}`)).status).toBe(404)
    expect((await call(`bridge?conversation_id=${row.conversation_id}`, undefined, auth)).status).toBe(404)
    expect((await call(`conversations/${row.conversation_id}?synthetic_id=${syntheticId}`)).status).toBe(403)
    expect((await call(`conversations/${row.conversation_id}?synthetic_id=${syntheticId}`, undefined, ownerAuth)).data.data.turns.at(-1).reply.detail).toBe('Synthetic answer')
    expect((await call('requests')).data.data).toHaveLength(1)
    expect((await call('requests', { ...input(), follow_up_to: row.request_id })).status).toBe(404)
    expect((await call(`requests/${row.request_id}/retry`, {})).status).toBe(404)
    expect((await call('selections', { answer_id: row.request_id, action_id: 'test', client_key: randomUUID() })).status).toBe(404)
    const remove = async (id: string, headers = auth) => fetch(`${base}/api/ask/bridge?synthetic_id=${id}`, { method: 'DELETE', headers })
    expect((await remove(syntheticId, {} as typeof auth)).status).toBe(401)
    expect((await remove(secondId)).status).toBe(200)
    expect((await scoped()).data.data.pending).toEqual([]) // answered, not deleted
    expect((await remove(syntheticId)).status).toBe(200)
    expect((await remove(syntheticId)).status).toBe(200) // lost cleanup ack is safe
    reload()
    expect(JSON.parse(await readFile(join(root, 'ask-requests.json'), 'utf8')).map((r: { request_id: string }) => r.request_id)).toEqual([regular.request_id])
  })
})

it('restores owned archives persistently and resurfaces only a newly answered turn', async () => {
  const { call, bridge, reload } = await setup()
  const id = (await call('requests', input())).data.data.request_id
  await call(`requests/${id}/dismiss`, {})
  expect((await bridge()).data.data.pending).toMatchObject([{ request_id: id }])
  expect((await call(`requests/${id}/restore`, {}, { 'Tailscale-User-Login': other, 'X-Tinstar-UI': '1' })).status).toBe(404)
  expect((await call(`requests/${id}/restore`, {})).status).toBe(200)
  reload()
  expect((await call('requests')).data.data[0].dismissed_at).toBeNull()
  await call(`requests/${id}/dismiss`, {})
  await bridge({ request_id: id, note: note(id) })
  await bridge({ request_id: id, reply: { id: 'note-1', at: new Date().toISOString(), body: 'A new answer', cursor: '1' } })
  reload()
  expect((await call('requests')).data.data[0]).toMatchObject({ dismissed_at: null, read_at: null, reply: { detail: 'A new answer' } })
})

it('archives and restores all owned conversation turns from one request', async () => {
  const { call, reload } = await setup()
  const first = (await call('requests', input())).data.data
  await call('requests', { ...input(), follow_up_to: first.request_id, question: 'A turn from another device' })
  const unrelated = (await call('requests', input())).data.data
  await call(`requests/${first.request_id}/dismiss`, {})
  reload()
  let rows = (await call('requests')).data.data
  expect(rows.filter((row: { conversation_id: string }) => row.conversation_id === first.conversation_id).every((row: { dismissed_at: string | null }) => !!row.dismissed_at)).toBe(true)
  expect(rows.find((row: { request_id: string }) => row.request_id === unrelated.request_id).dismissed_at).toBeNull()
  await call(`requests/${first.request_id}/restore`, {})
  reload()
  rows = (await call('requests')).data.data
  expect(rows.every((row: { dismissed_at: string | null }) => row.dismissed_at === null)).toBe(true)
})

it('retains authenticated worker terminal view identity and rejects a different home/task', async () => {
  const { call } = await setup()
  const execution = fixtureScene().executions.find(item => item.identity.task_id === 'linked-worker')!
  const body = { client_key: randomUUID(), target: { kind: 'execution', id: execution.id }, question: 'Why is this worker waiting?', view: { scene: 'overview', worker: { home: execution.home, task_id: execution.identity.task_id } } }
  const saved = await call('requests', body)
  expect(saved.status).toBe(200)
  expect(saved.data.data.context.return_to.view.worker).toEqual(body.view.worker)
  const wrongHome = await call('requests', { ...body, client_key: randomUUID(), view: { ...body.view, worker: { ...body.view.worker, home: '/another/home' } } })
  expect(wrongHome.status).toBe(409)
  const wrongTask = await call('requests', { ...body, client_key: randomUUID(), view: { ...body.view, worker: { ...body.view.worker, task_id: 'different-worker' } } })
  expect(wrongTask.status).toBe(409)
})

it.each([false, true])('preserves a completed answers read state on restore after archive=%s', async archived => {
  const { call, bridge, reload } = await setup()
  const id = (await call('requests', input())).data.data.request_id
  await bridge({ request_id: id, note: note(id) })
  await bridge({ request_id: id, reply: { id: 'note-1', at: new Date().toISOString(), body: 'Completed answer', cursor: '1' } })
  await call(`requests/${id}/read`, {})
  expect(deskConversations((await call('requests')).data.data)[0]).toMatchObject({ view: 'needs-you', unread: false, attention: false })
  const readAt = (await call('requests')).data.data[0].read_at
  if (archived) await call(`requests/${id}/dismiss`, {})
  await call(`requests/${id}/restore`, {})
  reload()
  const rows = (await call('requests')).data.data
  expect(rows[0]).toMatchObject({ dismissed_at: null, read_at: readAt })
  expect(deskConversations(rows)[0]).toMatchObject({ view: 'needs-you', unread: false, attention: false })
})

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decisionSubmitFixture } from '../../../../test-fixtures/reconciliation/decisionSubmit'
import { PreparedSubmissions, preparedSubmitInput } from '../preparedSubmissions'
import { leaseDuration } from '../cardLeases'
import { plainText } from '../workflowContent'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(count = 3) {
  const root = await mkdtemp(join(tmpdir(), 'desk-submit-')); roots.push(root)
  const fixture = decisionSubmitFixture(count), backend = await fixture.build(root)
  const session = await backend.reviews.create('owner', { operation_id: 'open', label: 'Independent review' })
  const claim = await backend.reviews.claim('owner', 'Reviewer', { operation_id: 'claim', review_session_token: session.review_session_token })
  const input = { operation_id: 'submit', review_session_token: session.review_session_token, lease_token: claim.lease_token!,
    packet_id: claim.packet!.id, packet_version: claim.packet!.version, request_id: claim.packet!.packet.binding.request_id,
    option_id: 'preview', next: { owner: 'Firstmate', status: 'Queued' as const } }
  return { root, fixture, backend, session, claim, input,
    submit: (value = input) => backend.submissions.submit('owner', 'Reviewer', 'owner-actor', value) }
}

it('records one exact source answer, releases and claims next without waiting for worker acknowledgment; same-id replay dedupes after restart', async () => {
  const f = await setup()
  const acknowledgment = vi.fn(() => {})
  const submissions = new PreparedSubmissions(f.backend.reviews, { ...f.backend.source, scheduleReconciliation: acknowledgment })
  const result = await submissions.submit('owner', 'Reviewer', 'owner-actor', f.input)
  expect(result).toMatchObject({ outcome: 'recorded', source_state: 'recorded-awaiting-worker-acknowledgment', next: { lease: { card_id: f.fixture.fixtures[1]!.cardId } } })
  expect(result.progress).toHaveLength(1)
  expect(f.backend.leases.status(f.claim.lease!.card_id)).toBeNull()
  const writes = f.fixture.writes.length
  const restarted = await f.fixture.build(f.root)
  expect(await restarted.submissions.submit('owner', 'Reviewer', 'owner-actor', f.input)).toMatchObject(result)
  expect(f.fixture.writes).toHaveLength(writes)
  expect((await restarted.submissions.metrics()).reviewed_today_utc).toBe(1)
  expect(acknowledgment).toHaveBeenCalledOnce()
})

it('rejects invented request/option ids, wrong packet versions and unauthorized next effects before source writes', async () => {
  const f = await setup()
  for (const change of [{ request_id: 'invented-sub-request' }, { option_id: 'yes' }, { packet_version: 2 }, { next: { owner: 'Anyone', status: 'Queued' as const } }]) {
    await expect(f.submit({ ...f.input, ...change })).rejects.toThrow()
  }
  expect(preparedSubmitInput.safeParse({ ...f.input, parts: [] }).success).toBe(false)
  expect(f.fixture.writes).toHaveLength(0)
})

it.each(['request', 'worker', 'source-unavailable'] as const)('blocks changed %s evidence at submit, preserves selection and lease', async kind => {
  const f = await setup()
  const source = { ...f.backend.source, evidence: async (...args: Parameters<typeof f.backend.source.evidence>) => {
    const e = await f.backend.source.evidence(...args)
    if (kind === 'request') e.requests[0]!.binding!.source_revision = 'new-source-revision'
    else if (kind === 'source-unavailable') e.reasons.push('Source incomplete')
    else e.requests[0]!.dependencies.find(dep => dep.kind === 'worker')!.revision = 'new-material-state'
    return e
  } }
  const result = await new PreparedSubmissions(f.backend.reviews, source).submit('owner', 'Reviewer', 'owner-actor', f.input)
  expect(result).toMatchObject({ outcome: kind === 'source-unavailable' ? 'source-unavailable' : 'packet-invalidated', selection: { option_id: 'preview' } })
  expect(f.backend.leases.status(f.claim.lease!.card_id)).toBeTruthy()
  expect(f.fixture.writes).toHaveLength(0)
})

it('retains definite failure with the same operation id; a retry succeeds without advancing on failure', async () => {
  const f = await setup()
  f.fixture.controls.reject = true
  expect(await f.submit()).toMatchObject({ outcome: 'not-saved', selection: { option_id: 'preview' } })
  expect(f.backend.leases.status(f.claim.lease!.card_id)).toBeTruthy()
  f.fixture.controls.reject = false
  expect(await f.submit()).toMatchObject({ outcome: 'recorded' })
})

it.each(['loseIntent', 'loseAnswer'] as const)('reconciles ambiguous %s markers before and after restart without duplicate source comments', async failure => {
  const f = await setup()
  f.fixture.controls[failure] = true
  const first = await f.submit()
  expect(['save-unconfirmed', 'recorded']).toContain(first.outcome)
  const restarted = await f.fixture.build(f.root)
  expect(await restarted.submissions.submit('owner', 'Reviewer', 'owner-actor', f.input)).toMatchObject({ outcome: 'recorded' })
  const notes = f.fixture.comments.get(f.claim.lease!.card_id)!.map(note => plainText(note.rich_text))
  expect(notes.filter(text => text.startsWith('Tin Star decision intent:'))).toHaveLength(1)
  expect(notes.filter(text => text.includes('\nOperation: answer_decision'))).toHaveLength(1)
})

it('does not blindly replay an ambiguous mutable property request after restart; existing audited reconciliation unblocks the same id', async () => {
  const f = await setup()
  f.fixture.controls.loseProperty = true
  expect(await f.submit()).toMatchObject({ outcome: 'save-unconfirmed' })
  const writes = f.fixture.writes.length
  const restarted = await f.fixture.build(f.root)
  expect(await restarted.submissions.submit('owner', 'Reviewer', 'owner-actor', f.input)).toMatchObject({ outcome: 'save-unconfirmed' })
  expect(f.fixture.writes).toHaveLength(writes)
  const pending = restarted.leases.pendingWrites()[0]!
  expect(pending.intent).toContain('properties')
  await restarted.leases.reconcileWrite(pending.card, pending.operation, 'owner', 'Isolated transport settled and properties read back', async () => 'applied')
  expect(await restarted.submissions.submit('owner', 'Reviewer', 'owner-actor', f.input)).toMatchObject({ outcome: 'recorded' })
  expect(f.fixture.writes.filter(write => write.method === 'PATCH')).toHaveLength(1)
})

it('exposes a partial source write without marking the request recorded and retains selection on retry', async () => {
  const f = await setup()
  f.fixture.controls.failAnswer = true
  expect(await f.submit()).toMatchObject({ outcome: 'save-unconfirmed', selection: { option_id: 'preview' } })
  expect((await f.backend.submissions.metrics()).reviewed_today_utc).toBe(0)
  expect(f.backend.leases.status(f.claim.lease!.card_id)).toBeTruthy()
  f.fixture.controls.failAnswer = false
  // 503 without an immutable marker remains fenced until explicit settled-source recovery.
  const pending = f.backend.leases.pendingWrites()[0]!
  await f.backend.leases.reconcileWrite(pending.card, pending.operation, 'owner', 'Provider rejected before applying final comment', async () => 'different')
  expect(await f.submit()).toMatchObject({ outcome: 'recorded' })
})

it('blocks an externally conflicting durable source intent before any selected answer is written', async () => {
  const f = await setup()
  f.fixture.controls.loseIntent = true
  await f.submit()
  const note = f.fixture.comments.get(f.claim.lease!.card_id)!.find(note => plainText(note.rich_text).startsWith('Tin Star decision intent:'))!
  const text = plainText(note.rich_text).replace('Authorize preview only', 'Different external answer')
  note.rich_text = [{ text: { content: text } }]
  const writes = f.fixture.writes.length
  expect(await f.submit()).toMatchObject({ outcome: 'answer-conflict' })
  expect(f.fixture.writes).toHaveLength(writes)
})

it('returns recorded-empty on next outage; never keeps the answered lease or resubmits the answer', async () => {
  const f = await setup()
  f.fixture.controls.queueUnavailable = true
  expect(await f.submit()).toMatchObject({ outcome: 'recorded-empty', next: { outcome: 'next-unavailable' } })
  expect(f.backend.leases.status(f.claim.lease!.card_id)).toBeNull()
  const writes = f.fixture.writes.length
  f.fixture.controls.queueUnavailable = false
  expect(await f.submit()).toMatchObject({ outcome: 'recorded', next: { lease: { card_id: f.fixture.fixtures[1]!.cardId } } })
  expect(f.fixture.writes).toHaveLength(writes)
})

it('recovers a crash after source readback but before local release on the same operation id', async () => {
  const f = await setup()
  const realFinish = f.backend.reviews.finishInStorage.bind(f.backend.reviews)
  vi.spyOn(f.backend.reviews, 'finishInStorage').mockImplementationOnce(() => { throw new Error('Crash before release') })
  expect(await f.submit()).toMatchObject({ outcome: 'recorded-releasing' })
  expect(f.backend.leases.status(f.claim.lease!.card_id)).toBeTruthy()
  const writes = f.fixture.writes.length
  f.backend.reviews.finishInStorage = realFinish
  const restarted = await f.fixture.build(f.root)
  expect(await restarted.submissions.submit('owner', 'Reviewer', 'owner-actor', f.input)).toMatchObject({ outcome: 'recorded' })
  expect(f.fixture.writes).toHaveLength(writes)
})

it('fences expired leases before write and leaves Notion unchanged', async () => {
  const f = await setup()
  f.backend.leases.readStorage(db => db.prepare('UPDATE leases SET expires = ? WHERE card = ?').run(Date.now() - leaseDuration, f.claim.lease!.card_id))
  expect(await f.submit()).toMatchObject({ outcome: 'lease-lost', selection: { option_id: 'preview' } })
  expect(f.fixture.writes).toHaveLength(0)
})

it('skip and need-research never answer; research withdrawal cannot be resurrected by revalidation', async () => {
  const f = await setup()
  const before = JSON.stringify([...f.fixture.pages])
  const skipped = await f.backend.reviews.release('owner', 'Reviewer', { operation_id: 'skip', lease_token: f.claim.lease_token, reason: 'Another first', action: 'skip' })
  expect('next' in skipped ? skipped.next?.lease?.card_id : null).not.toBe(f.claim.lease!.card_id)
  const other = await f.backend.reviews.claim('other', 'Other', { operation_id: 'reclaim' })
  expect(other.lease?.card_id).toBe(f.claim.lease!.card_id)
  await f.backend.reviews.release('other', 'Other', { operation_id: 'research', lease_token: other.lease_token, reason: 'Need rollback evidence', action: 'research' })
  await f.backend.packets.validate(f.claim.packet!.id, f.fixture.fixtures[0]!.evidence, 'fixture')
  expect(await f.backend.packets.read(f.claim.packet!.id, f.fixture.fixtures[0]!.evidence)).toMatchObject({ ready: false })
  expect(f.fixture.writes).toHaveLength(0)
  expect(JSON.stringify([...f.fixture.pages])).toBe(before)
})

it('requires selected scope confirmation for high risk and difficult rollback, with no write when canceled', async () => {
  const f = await setup()
  // Publish an explicitly high-risk source-bound replacement and reclaim it.
  await f.backend.reviews.release('owner', 'Reviewer', { operation_id: 'release', lease_token: f.claim.lease_token, reason: 'Replace research' })
  const packet = structuredClone(f.fixture.fixtures[0]!.packet); packet.risk.rating = 'High'
  await f.backend.packets.publish(packet, f.fixture.fixtures[0]!.evidence, 'fixture', 'high-risk')
  const claim = await f.backend.reviews.claim('owner', 'Reviewer', { operation_id: 'high-risk', review_session_token: f.session.review_session_token })
  const input = { ...f.input, lease_token: claim.lease_token!, packet_id: claim.packet!.id, packet_version: claim.packet!.version }
  expect(await f.submit(input)).toMatchObject({ outcome: 'confirmation-required', confirmation: { selected_option: 'Authorize preview only', scope: packet.authorization.scope, adverse_impact: packet.risk.explanation } })
  expect(f.fixture.writes).toHaveLength(0)
  expect(await f.backend.submissions.submit('owner', 'Reviewer', 'owner-actor', { ...input, confirmation: { option_id: input.option_id, scope: packet.authorization.scope } })).toMatchObject({ outcome: 'recorded' })
})

it('restores retained selections only to their authenticated real session after restart', async () => {
  const f = await setup()
  f.fixture.controls.reject = true
  await f.submit()
  const restarted = await f.fixture.build(f.root)
  expect(await restarted.submissions.recover('owner', { review_session_token: f.session.review_session_token })).toMatchObject({ submissions: [{ operation_id: 'submit', selection: { request_id: f.input.request_id, option_id: 'preview' }, state: 'not-saved' }] })
  await expect(restarted.submissions.recover('intruder', { review_session_token: f.session.review_session_token })).rejects.toThrow('Claim lost')
  const other = await restarted.reviews.create('owner', { operation_id: 'other-context', label: 'Other real context' })
  expect(await restarted.submissions.recover('owner', { review_session_token: other.review_session_token })).toEqual({ submissions: [] })
})

it('suppresses concurrent double submission and requires the original id for ambiguous attempts', async () => {
  const f = await setup()
  const results = await Promise.all([f.submit(), f.submit()])
  expect(results.some(result => result.outcome === 'recorded')).toBe(true)
  expect(f.fixture.comments.get(f.claim.lease!.card_id)!.filter(note => plainText(note.rich_text).includes('\nOperation: answer_decision'))).toHaveLength(1)
  expect((await f.backend.submissions.metrics()).reviewed_today_utc).toBe(1)
})

it('lets a reviewer change an unsubmitted high-risk selection using a new operation, before any write', async () => {
  const f = await setup()
  await f.backend.reviews.release('owner', 'Reviewer', { operation_id: 'release', lease_token: f.claim.lease_token })
  const packet = structuredClone(f.fixture.fixtures[0]!.packet); packet.reversibility.rating = 'Difficult'
  await f.backend.packets.publish(packet, f.fixture.fixtures[0]!.evidence, 'fixture', 'difficult')
  const held = await f.backend.reviews.claim('owner', 'Reviewer', { operation_id: 'difficult', review_session_token: f.session.review_session_token })
  const input = { ...f.input, packet_id: held.packet!.id, packet_version: held.packet!.version, lease_token: held.lease_token! }
  expect(await f.submit(input)).toMatchObject({ outcome: 'confirmation-required' })
  expect(await f.submit({ ...input, operation_id: 'changed-choice', option_id: 'defer' })).toMatchObject({ outcome: 'confirmation-required', selection: { option_id: 'defer' } })
  expect(f.fixture.writes).toHaveLength(0)
})

it('keeps ambiguous operations out of Ready and cannot skip them into another reviewer', async () => {
  const f = await setup()
  f.fixture.controls.loseProperty = true
  await f.submit()
  await expect(f.backend.reviews.release('owner', 'Reviewer', { operation_id: 'skip-ambiguous', lease_token: f.claim.lease_token, action: 'skip' })).rejects.toThrow('Source write unresolved')
  const other = await f.backend.reviews.claim('other', 'Other', { operation_id: 'other-card' })
  expect(other.lease?.card_id).not.toBe(f.claim.lease!.card_id)
})

it('retains durable success even when the asynchronous worker bridge throws', async () => {
  const f = await setup()
  const leaseAtDispatch: unknown[] = []
  const submissions = new PreparedSubmissions(f.backend.reviews, { ...f.backend.source, scheduleReconciliation: () => { leaseAtDispatch.push(f.backend.leases.status(f.claim.lease!.card_id)); throw new Error('Bridge unavailable') } })
  expect(await submissions.submit('owner', 'Reviewer', 'owner-actor', f.input)).toMatchObject({ outcome: 'recorded', source_state: 'recorded-awaiting-worker-acknowledgment' })
  expect(leaseAtDispatch).toEqual([null])
})

it('tracks two independently identified requests on one card with their own vocabulary; a later timeout reports prior durable progress only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desk-independent-')); roots.push(root)
  const fixture = decisionSubmitFixture(1), f = fixture.fixtures[0]!
  const source = { ...f.packet.binding.source_request, id: 'independent-followup' }
  const home = f.snapshot.fleet.find(home => home.source.home === source.home)!.observation.data!
  const hold = structuredClone(home.backlog!.find(row => row.id === f.packet.binding.source_request.id)!)
  hold.id = source.id; hold.hold_reason = 'Choose the independent evidence format?'; hold.title = hold.hold_reason
  home.backlog!.push(hold)
  home.tasks[0]!.queue!.decisions.push({ key: source.id, verb: 'needs-decision', summary: hold.hold_reason })
  const question = `Operation: request_decision\nRequested from: Will\nQuestion: ${hold.hold_reason}\nTin Star request: ${JSON.stringify({ id: 'format-request', action: 'Decision', preserve_action: false, source_request: source, source_question: hold.hold_reason, source_spawn_gen: 'attempt-1', options: [{ id: 'table', label: 'Use a table' }, { id: 'prose', label: 'Use prose' }] })}`
  fixture.comments.get(f.cardId)!.push({ id: 'source-format-request', rich_text: [{ text: { content: question } }] })
  const b = await fixture.build(root)
  const firstPacket = (await b.packets.read((await b.packets.ids())[0]!))!
  const all = await b.source.evidence(firstPacket)
  f.evidence = all
  f.packet.binding = all.requests.find(request => request.binding?.request_id === 'preview-question')!.binding!
  f.packet.dependencies = all.requests.find(request => request.binding?.request_id === 'preview-question')!.dependencies.map(dep => ({ kind: dep.kind, key: dep.key, revision: dep.revision! }))
  await b.packets.publish(f.packet, all, 'fixture', 'first-current')
  const session = await b.reviews.create('owner', { operation_id: 'open', label: 'Review' })
  const first = await b.reviews.claim('owner', 'Reviewer', { operation_id: 'claim', review_session_token: session.review_session_token })
  expect(await b.submissions.submit('owner', 'Reviewer', 'owner-actor', { operation_id: 'first-answer', lease_token: first.lease_token,
    packet_id: first.packet!.id, packet_version: first.packet!.version, request_id: 'preview-question', option_id: 'preview', next: { owner: 'Firstmate', status: 'Queued' } })).toMatchObject({ outcome: 'recorded-empty' })
  // Independent source owner republishes its remaining ask after the first
  // answer queued follow-up. P3 does not invent an aggregate transition policy.
  const page = fixture.pages.get(f.cardId)!
  page.properties.Status = { id: 'Status', type: 'status', status: { name: 'In Progress' } }
  const evidence = await b.source.evidence(firstPacket), request = evidence.requests.find(row => row.binding?.request_id === 'format-request')!
  f.evidence = evidence
  const packet = { ...structuredClone(f.packet), binding: request.binding!, question: request.question!, recommended_option_id: 'table',
    dependencies: request.dependencies.map(dep => ({ kind: dep.kind, key: dep.key, revision: dep.revision! })) }
  const published = await b.packets.publish(packet, evidence, 'fixture', 'independent-format-packet')
  expect(published.validation).toMatchObject({ valid: true, reasons: [] })
  const second = await b.reviews.claim('owner', 'Reviewer', { operation_id: 'second-claim', review_session_token: session.review_session_token })
  expect(second.lease?.card_id).toBe(f.cardId)
  fixture.controls.loseIntent = true
  const result = await b.submissions.submit('owner', 'Reviewer', 'owner-actor', { operation_id: 'second-answer', lease_token: second.lease_token,
    packet_id: second.packet!.id, packet_version: second.packet!.version, request_id: 'format-request', option_id: 'table', next: { owner: 'Firstmate', status: 'Queued' } })
  expect(result).toMatchObject({ outcome: 'save-unconfirmed', card_progress: 'partial', progress: [{ request_id: 'preview-question' }], selection: { request_id: 'format-request', option_id: 'table' } })
  expect((await b.submissions.metrics()).reviewed_today_utc).toBe(1)
  expect(fixture.comments.get(f.cardId)!.some(note => plainText(note.rich_text).includes('"answer":"Use a table"'))).toBe(true)
})

it('checks the declared PR head again at submit, rather than trusting a still-current request revision', async () => {
  const f = await setup()
  await f.backend.reviews.release('owner', 'Reviewer', { operation_id: 'release-pr', lease_token: f.claim.lease_token })
  const source = f.fixture.fixtures[0]!, packet = structuredClone(source.packet)
  const dependency = { kind: 'pr-head' as const, key: 'https://github.com/example/isolated/pull/1', revision: 'old-head' }
  packet.dependencies.push(dependency)
  source.evidence.requests[0]!.dependencies.push({ ...dependency, status: 'fresh', coverage: 'complete', observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() })
  await f.backend.packets.publish(packet, source.evidence, 'fixture', 'pr-dependent')
  const held = await f.backend.reviews.claim('owner', 'Reviewer', { operation_id: 'pr-claim', review_session_token: f.session.review_session_token })
  const backend = new PreparedSubmissions(f.backend.reviews, { ...f.backend.source, evidence: async (...args) => {
    const current = await f.backend.source.evidence(...args)
    current.requests[0]!.dependencies.push({ ...source.evidence.requests[0]!.dependencies.at(-1)!, revision: 'new-head' })
    return current
  } })
  expect(await backend.submit('owner', 'Reviewer', 'owner-actor', { ...f.input, packet_id: held.packet!.id, packet_version: held.packet!.version, lease_token: held.lease_token })).toMatchObject({ outcome: 'packet-invalidated' })
  expect(f.fixture.writes).toHaveLength(0)
})

it('reconciles a source answer saved before a readback outage, including restart, without repeating any write', async () => {
  const f = await setup()
  let observations = 0
  const partial = new PreparedSubmissions(f.backend.reviews, { ...f.backend.source, observe: async (...args) => {
    if (++observations === 2) throw new Error('Readback timeout after durable answer')
    return f.backend.source.observe(...args)
  } })
  expect(await partial.submit('owner', 'Reviewer', 'owner-actor', f.input)).toMatchObject({ outcome: 'save-unconfirmed' })
  expect(f.backend.leases.status(f.claim.lease!.card_id)).toBeTruthy()
  const writes = f.fixture.writes.length
  const restarted = await f.fixture.build(f.root)
  expect(await restarted.submissions.submit('owner', 'Reviewer', 'owner-actor', f.input)).toMatchObject({ outcome: 'recorded' })
  expect(f.fixture.writes).toHaveLength(writes)
})


it.each([1, 2, 3])('deduplicates one held submit across independent backend processes sharing the durable store (round %i)', async () => {
  const f = await setup()
  const sourceServer = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    try {
      const response = await f.fixture.fetcher(`https://api.notion.com${req.url}`, { method: req.method, ...(chunks.length ? { body: Buffer.concat(chunks).toString() } : {}) })
      res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text())
    } catch { res.destroy() }
  })
  await new Promise<void>(resolve => sourceServer.listen(0, '127.0.0.1', resolve))
  const sourceUrl = `http://127.0.0.1:${(sourceServer.address() as { port: number }).port}`
  const inputPath = join(f.root, 'isolated-input.json')
  await writeFile(inputPath, JSON.stringify(f.input), { mode: 0o600 })
  const module = pathToFileURL(resolve('test-fixtures/reconciliation/decisionSubmit.ts')).href
  try {
    const children = await Promise.all(Array.from({ length: 2 }, () => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import {decisionSubmitFixture} from ${JSON.stringify(module)};
      import {readFileSync} from 'node:fs';
      const fixture = decisionSubmitFixture();
      const transport = (url, init) => {const parsed = new URL(url); return fetch(${JSON.stringify(sourceUrl)} + parsed.pathname + parsed.search, init)};
      const backend = await fixture.build(${JSON.stringify(f.root)}, transport);
      const result = await backend.submissions.submit('owner','Reviewer','owner-actor',JSON.parse(readFileSync(${JSON.stringify(inputPath)},'utf8')));
      process.stdout.write(JSON.stringify({outcome:result.outcome}));
    `])))
    expect(children.some(child => JSON.parse(child.stdout).outcome === 'recorded')).toBe(true)
    expect(await f.submit()).toMatchObject({ outcome: 'recorded' })
    const comments = f.fixture.comments.get(f.claim.lease!.card_id)!.map(note => plainText(note.rich_text))
    expect(comments.filter(text => text.startsWith('Tin Star decision intent:'))).toHaveLength(1)
    expect(comments.filter(text => text.includes('\nOperation: answer_decision'))).toHaveLength(1)
    expect(f.fixture.writes.filter(write => write.method === 'PATCH')).toHaveLength(1)
  } finally {
    sourceServer.closeAllConnections(); await new Promise<void>(resolve => sourceServer.close(() => resolve()))
  }
}, 30_000)

it('reclaims an expired lease and a fresh research version for the same source revision, preserving the original source operation', async () => {
  const f = await setup()
  f.fixture.controls.loseIntent = true
  expect(await f.submit()).toMatchObject({ outcome: 'save-unconfirmed' })
  f.backend.leases.readStorage(db => {
    db.prepare('UPDATE leases SET expires = ? WHERE card = ?').run(Date.now() - 1, f.claim.lease!.card_id)
    db.prepare('UPDATE decision_packets SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1).toISOString(), f.input.packet_id)
  })
  // Same-ID reconciliation settles the immutable marker before explicit reclaim.
  expect(await f.submit()).toMatchObject({ outcome: 'lease-lost' })
  await f.backend.packets.publish(f.fixture.fixtures[0]!.packet, f.fixture.fixtures[0]!.evidence, 'fixture', 'refreshed-research')
  const fresh = await f.backend.reviews.claim('owner', 'Reviewer', { operation_id: 'reclaim', review_session_token: f.session.review_session_token })
  expect(fresh.packet!.version).toBe(2)
  expect(await f.submit({ ...f.input, packet_id: fresh.packet!.id, packet_version: fresh.packet!.version, lease_token: fresh.lease_token! })).toMatchObject({ outcome: 'recorded' })
  expect(f.fixture.comments.get(f.claim.lease!.card_id)!.filter(note => plainText(note.rich_text).startsWith('Tin Star decision intent:'))).toHaveLength(1)
})

it('requires the original capability to transfer retained input into a different real review context', async () => {
  const f = await setup()
  f.fixture.controls.reject = true
  await f.submit()
  const newSession = await f.backend.reviews.create('owner', { operation_id: 'replacement-session', label: 'Explicit replacement' })
  expect(await f.backend.submissions.recover('owner', { review_session_token: newSession.review_session_token })).toEqual({ submissions: [] })
  expect(await f.backend.submissions.recover('owner', { review_session_token: newSession.review_session_token, original_lease_token: f.input.lease_token })).toMatchObject({ submissions: [{ operation_id: f.input.operation_id }] })
  await f.backend.reviews.close('owner', f.session.review_session_token, 'Explicit replacement')
  const held = await f.backend.reviews.claim('owner', 'Reviewer', { operation_id: 'replacement-claim', review_session_token: newSession.review_session_token })
  f.fixture.controls.reject = false
  const retry = { ...f.input, review_session_token: newSession.review_session_token, lease_token: held.lease_token! }
  expect(await f.submit(retry)).toMatchObject({ outcome: 'lease-lost' })
  expect(await f.backend.submissions.submit('owner', 'Reviewer', 'owner-actor', { ...retry, original_lease_token: f.input.lease_token })).toMatchObject({ outcome: 'recorded' })
})

it('commits research withdrawal and release when the next allocation is unavailable, then retries next safely', async () => {
  const f = await setup()
  f.fixture.controls.queueUnavailable = true
  const input = { operation_id: 'research-outage', lease_token: f.claim.lease_token, action: 'research' }
  expect(await f.backend.reviews.release('owner', 'Reviewer', input)).toMatchObject({ outcome: 'research-requested', next: { outcome: 'next-unavailable' } })
  expect(f.backend.leases.status(f.claim.lease!.card_id)).toBeNull()
  expect(await f.backend.packets.read(f.input.packet_id, f.fixture.fixtures[0]!.evidence)).toMatchObject({ ready: false })
  f.fixture.controls.queueUnavailable = false
  expect(await f.backend.reviews.release('owner', 'Reviewer', input)).toMatchObject({ outcome: 'research-requested', next: { lease: { card_id: f.fixture.fixtures[1]!.cardId } } })
  expect(f.fixture.writes).toHaveLength(0)
})

it.each(['lost response', 'expired during observation'])('reports the authoritative transfer capability after %s and restart', async failure => {
  const f = await setup()
  f.fixture.controls.reject = true
  await f.submit()
  await f.backend.reviews.close('owner', f.session.review_session_token, 'Replace A')
  const sessionB = await f.backend.reviews.create('owner', { operation_id: 'session-b', label: 'B' })
  const heldB = await f.backend.reviews.claim('owner', 'Reviewer', { operation_id: 'claim-b', review_session_token: sessionB.review_session_token, card_id: f.claim.lease!.card_id })
  const transferred = { ...f.input, review_session_token: sessionB.review_session_token, lease_token: heldB.lease_token!, original_lease_token: f.input.lease_token }
  const source = { ...f.backend.source, observe: async (...args: Parameters<typeof f.backend.source.observe>) => {
    const result = await f.backend.source.observe(...args)
    if (failure === 'expired during observation') f.backend.leases.readStorage(db => { db.prepare('UPDATE leases SET expires = ? WHERE card = ?').run(Date.now() - 1, f.claim.lease!.card_id) })
    return result
  } }
  const result = await new PreparedSubmissions(f.backend.reviews, source).submit('owner', 'Reviewer', 'owner-actor', transferred)
  expect(result.outcome).toBe(failure === 'lost response' ? 'not-saved' : 'lease-lost')
  await f.backend.reviews.close('owner', sessionB.review_session_token, 'Replace B')
  const restarted = await f.fixture.build(f.root)
  const sessionC = await restarted.reviews.create('owner', { operation_id: 'session-c', label: 'C' })
  const lookup = (token: string) => restarted.submissions.recover('owner', { review_session_token: sessionC.review_session_token, original_lease_token: token })
  expect(await lookup(f.input.lease_token)).toEqual({ submissions: [] })
  expect(await lookup(heldB.lease_token!)).toMatchObject({ submissions: [{ operation_id: f.input.operation_id, binding_matches_original_lease: true, selection: { option_id: f.input.option_id } }] })
  const heldC = await restarted.reviews.claim('owner', 'Reviewer', { operation_id: 'claim-c', review_session_token: sessionC.review_session_token, card_id: f.claim.lease!.card_id })
  const retry = { ...transferred, review_session_token: sessionC.review_session_token, lease_token: heldC.lease_token! }
  expect(await restarted.submissions.submit('owner', 'Reviewer', 'owner-actor', retry)).toMatchObject({ outcome: 'lease-lost' })
  f.fixture.controls.reject = false
  expect(await restarted.submissions.submit('owner', 'Reviewer', 'owner-actor', { ...retry, original_lease_token: heldB.lease_token! })).toMatchObject({ outcome: 'recorded' })
})

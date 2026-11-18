import { isOwnerDecisionHeading } from '../../../../scripts/decision-owner-answer-sweep'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CardLeases } from '../cardLeases'
import { DecisionPackets, packetContentHash } from '../decisionPackets'
import { decisionPacketSchema, validateDecisionPacket } from '../../../shared/decisionPacket'
import { projectDecisionEvidence } from '../decisionEvidence'
import { preparedDecisionFixture } from '../../../../test-fixtures/reconciliation/preparedDecision'
import { ReconciliationSources } from '../index'
import { CardContextReader } from '../cardContext'

const roots: string[] = []
const now = Date.parse('2026-11-15T18:00:00Z')
async function store(clock = () => now) {
  const root = await mkdtemp(join(tmpdir(), 'decision-packets-')); roots.push(root)
  const leases = new CardLeases(root, clock)
  return { root, leases, packets: new DecisionPackets(leases, clock) }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it('hashes meaning independent of object/reference/dependency/option order and line endings', () => {
  const { packet } = preparedDecisionFixture(now)
  const same = structuredClone(packet)
  same.dependencies.reverse(); same.binding.options.reverse(); same.background += '\r\nMore evidence'
  packet.background += '\nMore evidence'
  same.references = [{ url: same.references[0]!.url, label: same.references[0]!.label }]
  expect(packetContentHash(same)).toBe(packetContentHash(packet))
  same.binding.source_revision = 'changed question and options'
  expect(packetContentHash(same)).not.toBe(packetContentHash(packet))
})

it.each(['card', 'request', 'revision', 'option', 'question', 'answered', 'partial', 'stale', 'unknown', 'material-unknown', 'missing-dependency', 'extra-dependency'] as const)('blocks %s mismatch or inadequate evidence', kind => {
  const { packet, evidence } = preparedDecisionFixture(now)
  expect(validateDecisionPacket(packet, evidence, now)).toMatchObject({ valid: true })
  if (kind === 'card') evidence.card_id = 'f'.repeat(32)
  if (kind === 'request') evidence.requests[0]!.binding!.source_request!.id = 'other'
  if (kind === 'revision') evidence.requests[0]!.binding!.source_revision = 'new revision'
  if (kind === 'option') evidence.requests[0]!.binding!.options[0]!.label = 'Production instead'
  if (kind === 'question') packet.question = 'Authorize something else?'
  if (kind === 'answered') evidence.requests[0]!.answered = true
  if (kind === 'partial') evidence.requests[0]!.dependencies[0]!.coverage = 'partial'
  if (kind === 'stale') evidence.requests[0]!.dependencies[0]!.expires_at = new Date(now).toISOString()
  if (kind === 'unknown') evidence.requests[0]!.dependencies[0]!.status = 'unknown'
  if (kind === 'material-unknown') packet.material_unknowns.push('The blast radius is not established')
  if (kind === 'missing-dependency') packet.dependencies.pop()
  if (kind === 'extra-dependency') packet.dependencies.push({ kind: 'release', key: 'unobserved-proof', revision: 'claimed' })
  const result = validateDecisionPacket(packet, evidence, now)
  expect(result.valid).toBe(false); expect(result.reasons.length).toBeGreaterThan(0)
})

it.each(['explicit', 'declared'] as const)('uses the projection clock for %s source binding freshness', kind => {
  const fixture = preparedDecisionFixture(now)
  if (kind === 'declared') {
    for (const home of fixture.snapshot.fleet) {
      for (const task of home.observation.data?.tasks ?? []) task.cardReferences = []
      for (const row of home.observation.data?.backlog ?? []) row.cardReferences = []
    }
  }
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 86_400_000)
  try {
    const evidence = projectDecisionEvidence(fixture.snapshot, fixture.cardId, fixture.history, now)
    expect(validateDecisionPacket(fixture.packet, evidence, now)).toMatchObject({ valid: true })
    const expired = projectDecisionEvidence(fixture.snapshot, fixture.cardId, fixture.history, now + 86_400_000)
    expect(validateDecisionPacket(fixture.packet, expired, now + 86_400_000).valid).toBe(false)
  } finally { clock.mockRestore() }
})

it('publishes immutable versions with idempotent operation identity and survives restart', async () => {
  const { packet, evidence } = preparedDecisionFixture(now), { packets, root, leases } = await store()
  const first = await packets.publish(packet, evidence, 'fixture-preparer', 'publish-one')
  expect(first).toMatchObject({ version: 1, validation: { valid: true }, replayed: false })
  expect(await packets.publish(packet, evidence, 'fixture-preparer', 'publish-one')).toMatchObject({ id: first.id, replayed: true })
  expect(await packets.read(first.id, evidence)).toMatchObject({ ready: true })
  expect(await new DecisionPackets(new CardLeases(root, () => now), () => now).read(first.id, evidence)).toMatchObject({ id: first.id, ready: true })
  const changed = structuredClone(packet); changed.rationale = 'Updated investigation'
  await expect(packets.publish(changed, evidence, 'fixture-preparer', 'publish-one')).rejects.toThrow('different packet meaning')
  const second = await packets.publish(changed, evidence, 'fixture-preparer', 'publish-two')
  expect(second.version).toBe(2)
  expect(await packets.read(first.id, evidence)).toMatchObject({ content_hash: first.content_hash, packet: { rationale: packet.rationale }, ready: false, reasons: expect.arrayContaining(['Packet is superseded']) })
  expect(await packets.read(second.id, evidence)).toMatchObject({ ready: true })
  expect(leases.readStorage(db => db.prepare('SELECT count(*) AS n FROM decision_packets').get()!.n)).toBe(2)
})

it('withdraws eligibility on evidence expiry or review lease without mutating the packet', async () => {
  let clock = now
  const { packet, evidence } = preparedDecisionFixture(now), { packets, leases } = await store(() => clock)
  const first = await packets.publish(packet, evidence, 'fixture-preparer', 'one')
  const claim = await leases.claim([packet.binding.card_id], 'fixture-caller', 'Fixture', 'claim')
  expect(await packets.read(first.id, evidence)).toMatchObject({ ready: false, reasons: expect.arrayContaining(['Canonical card is leased to a reviewer']) })
  if (!('lease_token' in claim) || !claim.lease_token) throw new Error('Missing claim token')
  await leases.release('fixture-caller', claim.lease_token, 'test release')
  expect(await packets.read(first.id, evidence)).toMatchObject({ ready: true })
  clock += 60_000
  expect(await packets.read(first.id, evidence)).toMatchObject({ ready: false })
  expect(await packets.read(first.id)).toMatchObject({ ready: false, reasons: expect.arrayContaining(['Current source evidence not supplied']) })
})

it('appends coverage attestations for unchanged revalidation and targets invalidations by dependency', async () => {
  const { packet, evidence } = preparedDecisionFixture(now), { packets, leases } = await store()
  const first = await packets.publish(packet, evidence, 'fixture-preparer', 'one')
  const dependency = packet.dependencies[0]!
  expect(await packets.invalidate(dependency, dependency.revision, 'changed-request', 'fixture')).toEqual([])
  expect(await packets.invalidate({ kind: 'pr-head', key: 'unrelated' }, 'changed', 'pr-head', 'fixture')).toEqual([])
  expect(await packets.invalidate(dependency, 'changed', 'changed-request', 'fixture')).toEqual([first.id])
  expect(await packets.read(first.id, evidence)).toMatchObject({ ready: false })
  await packets.validate(first.id, evidence, 'fixture-revalidation')
  expect(await packets.read(first.id, evidence)).toMatchObject({ ready: false })
  // A later observation establishes that the source actually returned to the
  // packet's original meaning; this is not a stale cache overriding a change.
  await packets.invalidate(dependency, dependency.revision, 'changed-request', 'fixture')
  await packets.validate(first.id, evidence, 'fixture-revalidation')
  expect(await packets.read(first.id, evidence)).toMatchObject({ ready: true, version: 1, content_hash: first.content_hash })
  expect((await packets.events()).map(event => event.type)).toEqual(['publication', 'validation', 'invalidation', 'validation', 'validation'])
  expect(leases.readStorage(db => db.prepare('SELECT count(*) AS n FROM decision_packet_validations').get()!.n)).toBe(3)
  const coverage = leases.readStorage(db => db.prepare('SELECT coverage FROM decision_packet_validations LIMIT 1').get()!.coverage)
  expect(JSON.parse(String(coverage))).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'fresh', coverage: 'complete' })]))
})

it('persists validated default policy, serializes competing saves, and refuses invalid settings', async () => {
  const { packets, root } = await store()
  expect(await packets.readPolicy('board')).toMatchObject({ version: 0, values: { target_ready: 10, max_preparers: 3, automatic_replenishment: false } })
  const rival = new DecisionPackets(new CardLeases(root, () => now), () => now)
  const update = { expected_version: 0, values: { target_ready: 15, max_preparers: 2, automatic_replenishment: false } }
  const results = await Promise.allSettled([packets.updatePolicy('board', update, 'owner-a'), rival.updatePolicy('board', update, 'owner-b')])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect(await new DecisionPackets(new CardLeases(root), () => now).readPolicy('board')).toMatchObject({ version: 1, values: update.values })
  for (const values of [{ ...update.values, target_ready: 31 }, { ...update.values, max_preparers: 0 }, { ...update.values, automatic_replenishment: 'yes' }]) await expect(packets.updatePolicy('board', { expected_version: 1, values }, 'owner')).rejects.toThrow()
  expect(await packets.readPolicy('board')).toMatchObject({ version: 1 })
})

it('ships a pre-existing replenishment-on row off until a later explicit save', async () => {
  const { packets, leases } = await store()
  await packets.ids()
  await leases.writeStorage(db => db.prepare('INSERT INTO decision_desk_policy VALUES(?,?,?,?,?)').run('board', 0, JSON.stringify({ target_ready: 10, max_preparers: 3, automatic_replenishment: true }), 'Will', '2026-11-01T00:00:00.000Z'))
  expect(await packets.readPolicy('board')).toMatchObject({ version: 0, updated_by: 'Will', values: { automatic_replenishment: false } })
  expect((await packets.events()).some(event => event.type === 'policy' && JSON.parse(String(event.detail)).migration === 'replenishment-off')).toBe(true)
  expect((await packets.updatePolicy('board', { expected_version: 0, values: { target_ready: 10, max_preparers: 3, automatic_replenishment: true } }, 'Will')).values.automatic_replenishment).toBe(true)
  expect((await packets.readPolicy('board')).values.automatic_replenishment).toBe(true)
})

it('keeps evidence projection pure and reports unavailable histories and changed worker/source', async () => {
  const fixture = preparedDecisionFixture(now)
  const before = JSON.stringify(fixture.snapshot)
  projectDecisionEvidence(fixture.snapshot, fixture.cardId, fixture.history, now)
  expect(JSON.stringify(fixture.snapshot)).toBe(before)
  expect(projectDecisionEvidence(fixture.snapshot, fixture.cardId, undefined, now).reasons).toContain('Complete cached decision history is unavailable')
  fixture.snapshot.fleet[1]!.observation.data!.tasks[0]!.identity.spawn_gen = 'another-attempt'
  expect(projectDecisionEvidence(fixture.snapshot, fixture.cardId, fixture.history, now).requests[0]!.reasons).toContain('Source question or worker generation changed')
  const { root } = await store(), network = vi.fn(() => { throw new Error('Source access forbidden by this test') })
  const sources = new ReconciliationSources({ fleet: [], warnings: [] }, network as typeof fetch, undefined, root)
  const workflow = vi.spyOn(sources.workflow, 'reconcileDecisions')
  const evidence = sources.preparationEvidence(fixture.cardId)
  expect(evidence.reasons).toContain('Canonical card is not in the observed configured board')
  expect(network).not.toHaveBeenCalled(); expect(workflow).not.toHaveBeenCalled()
})

it('refuses unsupported recommended options and duplicate dependency identities', () => {
  const { packet } = preparedDecisionFixture(now)
  expect(decisionPacketSchema.safeParse({ ...packet, recommended_option_id: 'invented' }).success).toBe(false)
  expect(decisionPacketSchema.safeParse({ ...packet, dependencies: [...packet.dependencies, packet.dependencies[0]] }).success).toBe(false)
})

it('changes revision for an actual changed source question and blocks its old packet', () => {
  const fixture = preparedDecisionFixture(now)
  fixture.snapshot.fleet[1]!.observation.data!.tasks[0]!.queue!.decisions[0]!.summary = 'Authorize a different preview scope?'
  const changed = projectDecisionEvidence(fixture.snapshot, fixture.cardId, fixture.history, now)
  expect(changed.requests[0]!.binding!.source_revision).not.toBe(fixture.packet.binding.source_revision)
  expect(validateDecisionPacket(fixture.packet, changed, now).valid).toBe(false)
  expect(packetContentHash({ ...fixture.packet, binding: changed.requests[0]!.binding! })).not.toBe(packetContentHash(fixture.packet))
})

it('does not invalidate evidence for cosmetic worker-link JSON formatting', () => {
  const fixture = preparedDecisionFixture(now)
  const card = fixture.snapshot.intentions.data!.cards.find(card => card.id === fixture.cardId)!
  card.properties['First Mate tasks']!.value = JSON.stringify(JSON.parse(String(card.properties['First Mate tasks']!.value)), null, 2)
  const changed = projectDecisionEvidence(fixture.snapshot, fixture.cardId, fixture.history, now)
  expect(changed.requests[0]!.dependencies.find(dependency => dependency.kind === 'card')!.revision).toBe(fixture.evidence.requests[0]!.dependencies.find(dependency => dependency.kind === 'card')!.revision)
  expect(validateDecisionPacket(fixture.packet, changed, now).valid).toBe(true)
})

function cardNativeFixture() {
  const f = preparedDecisionFixture(now)
  f.snapshot.fleet = []
  f.history.context.blocks[0]!.text = `Operation: request_decision\nRequested from: Will\nQuestion: ${f.packet.question}\nTin Star request: ${JSON.stringify({
    id: f.packet.binding.request_id, action: 'Decision', preserve_action: false, options: f.packet.binding.options,
  })}`
  f.evidence = projectDecisionEvidence(f.snapshot, f.cardId, f.history, now)
  f.packet.binding = f.evidence.requests[0]!.binding!
  f.packet.dependencies = f.evidence.requests[0]!.dependencies.map(({ kind, key, revision }) => ({ kind, key, revision: revision! }))
  return f
}

it('binds card-native requests without a fleet source and versions their packets normally', async () => {
  const f = cardNativeFixture(), { packets } = await store()
  expect(f.evidence.reasons).toEqual([])
  expect(f.evidence.requests[0]!.reasons).toEqual([])
  expect(f.packet.binding).toMatchObject({ source_request: null, source_spawn_gen: null, source_question: f.packet.question })
  expect(f.evidence.requests[0]!.dependencies.map(dep => dep.kind)).toEqual(['request', 'card', 'answer'])
  expect(validateDecisionPacket(f.packet, f.evidence, now).valid).toBe(true)
  const first = await packets.publish(f.packet, f.evidence, 'bot', 'native-first')
  expect(await packets.read(first.id, f.evidence)).toMatchObject({ ready: true, version: 1 })
  const second = await packets.publish(f.packet, f.evidence, 'bot', 'native-second')
  expect(await packets.read(second.id, f.evidence)).toMatchObject({ ready: true, version: 2 })
  expect(await packets.read(first.id, f.evidence)).toMatchObject({ ready: false })
})

it.each(['question', 'option', 'record', 'answered', 'partial', 'expired', 'duplicate', 'malformed-binding'] as const)('invalidates a card-native packet for %s evidence', kind => {
  const f = cardNativeFixture(), block = f.history.context.blocks[0]!
  if (kind === 'question') block.text = block.text.replace(f.packet.question, 'Authorize a different scope?')
  if (kind === 'option') block.text = block.text.replace('Authorize preview only', 'Authorize production')
  if (kind === 'record') block.id = 'replacement-record'
  if (kind === 'answered') f.history.context.blocks.push({ id: 'owner-answer', type: 'comment', text: `Tin Star answer: ${JSON.stringify(f.packet.binding.request_id)}` })
  if (kind === 'partial') f.history.context.commentsOutcome = 'unavailable'
  if (kind === 'expired') f.history.expires_at = new Date(now).toISOString()
  if (kind === 'duplicate') f.history.context.blocks.push({ ...block, id: 'duplicate-record' })
  if (kind === 'malformed-binding') block.text = block.text.replace('"action":"Decision"', '"action":"Decision","source_request":{}')
  const changed = projectDecisionEvidence(f.snapshot, f.cardId, f.history, now)
  expect(validateDecisionPacket(f.packet, changed, now).valid).toBe(false)
  if (kind === 'malformed-binding') expect(changed.requests[0]!.binding).toBeNull()
})

it('keeps native request keys scoped to the card and ignores cosmetic record changes', () => {
  const f = cardNativeFixture()
  const block = f.history.context.blocks[0]!
  const marker = 'Tin Star request: ', start = block.text.indexOf(marker), record = JSON.parse(block.text.slice(start + marker.length))
  record.options.reverse()
  block.text = block.text.slice(0, start) + marker + JSON.stringify(record)
  f.history.observed_at = new Date(now - 1000).toISOString()
  expect(validateDecisionPacket(f.packet, projectDecisionEvidence(f.snapshot, f.cardId, f.history, now), now).valid).toBe(true)
  const otherCard = 'e'.repeat(32), card = f.snapshot.intentions.data!.cards.find(card => card.id === f.cardId)!
  f.snapshot.intentions.data!.cards.push({ ...card, id: otherCard })
  const other = projectDecisionEvidence(f.snapshot, otherCard, f.history, now).requests[0]!.binding!
  expect(other.request_key).not.toBe(f.packet.binding.request_key)
})

it('restores unchanged research only after fresh evidence is observed after withdrawal', async () => {
  let clock = now
  const { packet, evidence } = preparedDecisionFixture(now), { packets } = await store(() => clock)
  const published = await packets.publish(packet, evidence, 'fixture', 'one')
  clock += 61_000
  expect(await packets.read(published.id, evidence)).toMatchObject({ ready: false })
  await packets.invalidate(packet.dependencies[0]!, null, 'expired-evidence', 'fixture')
  expect(await packets.validate(published.id, evidence, 'fixture')).toMatchObject({ valid: false })
  clock += 1
  for (const observation of evidence.requests[0]!.dependencies) {
    observation.observed_at = new Date(clock).toISOString(); observation.expires_at = new Date(clock + 60_000).toISOString()
  }
  expect(await packets.validate(published.id, evidence, 'fixture')).toMatchObject({ valid: true })
  expect(await packets.read(published.id, evidence)).toMatchObject({ ready: true, version: 1, content_hash: published.content_hash })
})

it('indexes all material invalidation causes without touching unrelated dependencies', async () => {
  const { packet, evidence } = preparedDecisionFixture(now), { packets } = await store()
  for (const kind of ['pr-head', 'release', 'evidence'] as const) {
    packet.dependencies.push({ kind, key: `fixture-${kind}`, revision: 'first' })
    evidence.requests[0]!.dependencies.push({ kind, key: `fixture-${kind}`, revision: 'first', status: 'fresh', coverage: 'complete', observed_at: new Date(now).toISOString(), expires_at: new Date(now + 60_000).toISOString() })
  }
  const first = await packets.publish(packet, evidence, 'fixture', 'one')
  const causes = ['changed-request', 'source-closure', 'conflicting-answer', 'pr-head', 'critical-worker-state', 'expired-evidence'] as const
  const kinds = ['request', 'card', 'answer', 'pr-head', 'worker', 'evidence'] as const
  for (const [index, kind] of kinds.entries()) {
    const dependency = packet.dependencies.find(dependency => dependency.kind === kind)!
    expect(await packets.invalidate({ ...dependency, key: 'unrelated' }, 'new', causes[index]!, 'fixture')).toEqual([])
    expect(await packets.invalidate(dependency, 'new', causes[index]!, 'fixture')).toEqual([first.id])
  }
  expect((await packets.events()).filter(event => event.type === 'invalidation').map(event => JSON.parse(String(event.detail)).cause)).toEqual(causes)
  expect(await packets.read(first.id, evidence)).toMatchObject({ ready: false })
})

it.each(['answer', 'conflict', 'unanswered'] as const)('projects cached body %s alongside comment requests without source access', async kind => {
  const fixture = preparedDecisionFixture(now)
  const request = fixture.history.context.blocks[0]!
  const bodyText = kind === 'answer' ? 'Tin Star answer: "preview-question"' : kind === 'conflict' ? request.text.replace('Authorize preview only', 'Authorize production') : 'Background'
  const fetcher = vi.fn(async (input: URL | RequestInfo) => new Response(JSON.stringify({ has_more: false, results:
    new URL(String(input)).pathname === '/v1/comments'
      ? [{ id: request.id, rich_text: [{ plain_text: request.text }] }]
      : [{ id: 'body-history', type: 'paragraph', paragraph: { rich_text: [{ plain_text: bodyText }] } }],
  })))
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const reader = new CardContextReader({ token: 'fixture', dataSourceId: fixture.cardId }, fetcher)
  await reader.commentDetails(fixture.cardId)
  expect(reader.cachedDecisionHistory(fixture.cardId)).toBeUndefined()
  await reader.get(fixture.cardId)
  fetcher.mockClear()
  const history = reader.cachedDecisionHistory(fixture.cardId)!
  expect(history.context.blocks).toHaveLength(2)
  clock.mockRestore()
  const projected = projectDecisionEvidence(fixture.snapshot, fixture.cardId, history, now)
  expect(projected.requests.find(row => row.binding?.request_id === 'preview-question')?.answered).toBe(kind === 'answer')
  if (kind === 'conflict') expect(projected.reasons).toContain('Decision publication history is contradictory or incomplete')
  expect(validateDecisionPacket(fixture.packet, projected, now).valid).toBe(kind === 'unanswered')
  expect(fetcher).not.toHaveBeenCalled()
})

it.each(['body-partial', 'comments-partial', 'comments-unknown', 'expired', 'unknown-time'] as const)('blocks readiness with %s cached history', kind => {
  const fixture = preparedDecisionFixture(now)
  if (kind === 'body-partial') fixture.history.context.outcome = 'partial'
  if (kind === 'comments-partial') fixture.history.context.commentsOutcome = 'partial'
  if (kind === 'comments-unknown') delete fixture.history.context.commentsOutcome
  if (kind === 'expired') fixture.history.expires_at = new Date(now).toISOString()
  if (kind === 'unknown-time') fixture.history.observed_at = 'unknown'
  const evidence = projectDecisionEvidence(fixture.snapshot, fixture.cardId, fixture.history, now)
  expect(evidence.reasons).toContain('Complete cached decision history is unavailable')
  expect(evidence.requests[0]!.dependencies.find(row => row.kind === 'answer')!.status).toBe('unknown')
  expect(validateDecisionPacket(fixture.packet, evidence, now).valid).toBe(false)
})

it('keeps unchanged research Ready beyond its former review deadline only with newly read source evidence', async () => {
  let clock = now
  const { packet, evidence } = preparedDecisionFixture(clock), { packets } = await store(() => clock)
  const first = await packets.publish(packet, evidence, 'fixture-preparer', 'age-independent')
  clock += 2 * 3600_000
  expect(await packets.read(first.id, evidence)).toMatchObject({ ready: false })
  for (const dependency of evidence.requests[0]!.dependencies) {
    dependency.observed_at = new Date(clock).toISOString(); dependency.expires_at = new Date(clock + 30_000).toISOString()
  }
  await packets.validate(first.id, evidence, 'fresh-revision-check')
  expect(await packets.read(first.id, evidence)).toMatchObject({ ready: true, expires_at: null, published_at: first.published_at })
  expect(await packets.ids()).toEqual([first.id])
  evidence.requests[0]!.dependencies.find(dependency => dependency.kind === 'card')!.revision = 'changed-card-inputs'
  expect(await packets.read(first.id, evidence)).toMatchObject({ ready: false })
})

it.each(['edit', 'assign', 'park', 'answer_decision', 'comment', 'comment-name'] as const)('keeps the structured ask open after a non-request owner %s', kind => {
  const f = cardNativeFixture(), request = f.history.context.blocks[0]!
  request.createdAt = new Date(now - 20_000).toISOString()
  const owner = { id: 'owner-response', type: 'comment', createdAt: new Date(now - 10_000).toISOString(),
    text: kind.startsWith('comment') ? 'No decision keywords are necessary for this owner response.' : `Operation: ${kind}\nTin Star operation: ["owner-chatgpt","owner-response"]`,
    ...(kind === 'comment' ? { author: 'owner-chatgpt' } : kind === 'comment-name' ? { author: 'notion-owner-id', authorName: 'owner-chatgpt' } : {}) }
  const before = projectDecisionEvidence(f.snapshot, f.cardId, f.history, now)
  f.history.context.blocks.push(owner)
  const after = projectDecisionEvidence(f.snapshot, f.cardId, f.history, now)
  expect(after.requests[0]!.answered).toBe(false)
  expect(after.requests[0]!.binding?.source_revision).not.toBe(before.requests[0]!.binding?.source_revision)
  expect(validateDecisionPacket(f.packet, after, now).valid).toBe(false)
})

it.each(['earlier', 'same-time', 'other-author', 'unreceipted-wording', 'last-edited-only'] as const)('does not guess an owner answer from %s evidence', kind => {
  const f = cardNativeFixture(), request = f.history.context.blocks[0]!
  request.createdAt = new Date(now - 20_000).toISOString()
  f.history.context.blocks.push({ id: 'other-comment', type: 'comment', author: kind === 'other-author' ? 'firstmate' : kind === 'unreceipted-wording' ? undefined : 'owner-chatgpt',
    createdAt: new Date(now - (kind === 'same-time' ? 20_000 : kind === 'earlier' || kind === 'last-edited-only' ? 30_000 : 10_000)).toISOString(),
    last_edited_time: new Date(now).toISOString(), text: 'I approve. By: owner-chatgpt. Tin Star operation: ["owner-chatgpt","quoted"]' })
  expect(projectDecisionEvidence(f.snapshot, f.cardId, f.history, now).requests[0]!.answered).toBe(false)
})

it('rejects duplicate request IDs even with a newer meaningful publication', () => {
  const f = cardNativeFixture(), request = f.history.context.blocks[0]!
  request.createdAt = new Date(now - 20_000).toISOString()
  f.history.context.blocks.push({ id: 'owner-response', type: 'comment', createdAt: new Date(now - 10_000).toISOString(),
    text: 'Operation: edit\nTin Star operation: ["owner-chatgpt","owner-response"]' })
  expect(projectDecisionEvidence(f.snapshot, f.cardId, f.history, now).requests[0]!.answered).toBe(false)
  f.history.context.blocks.push({ ...request, id: 'new-request-revision', createdAt: new Date(now - 5_000).toISOString(),
    text: request.text.replace(f.packet.question, 'Authorize the revised preview scope?') })
  const revised = projectDecisionEvidence(f.snapshot, f.cardId, f.history, now)
  expect(revised.reasons).toContain('Decision publication history is contradictory or incomplete')
  expect(revised.requests.every(request => request.reasons.length > 0)).toBe(true)
  expect(validateDecisionPacket(f.packet, revised, now).valid).toBe(false)
})

it.each([
  ['OWNER DECISION (Will, 2026-11-16 10:59 PM ET, via Tinstar Decision Prep): Defer.', true],
  ['OWNER DECISION — 2026-11-17: Defer.', true],
  ['OWNER DECISION NEEDED: please pick an option', false],
  ['OWNER DECISION (Will): Defer.', false],
  ['OWNER DECISION — please choose: urgent', false],
  ['OWNER DECISION — 2026-11-17 Defer.', false],
])('classifies sweep heading %s', (text, expected) => {
  expect(isOwnerDecisionHeading(text)).toBe(expected)
})

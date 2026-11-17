import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CardLeases, leaseDuration, withLeaseCaller, sourceWriteDispatched } from '../cardLeases'
import { DecisionPackets } from '../decisionPackets'
import { PreparedReviews } from '../preparedReviews'
import type { DecisionEvidence } from '../../../shared/decisionPacket'
import { preparedDecisionFixture } from '../../../../test-fixtures/reconciliation/preparedDecision'
import { mainWaitNotifier } from '../waitingOnMain'
import { NotionApi } from '../notionApi'


const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function setup(count = 5, clock = { now: Date.now() }, transform = (fixture: ReturnType<typeof preparedDecisionFixture>) => fixture) {
  const root = await mkdtemp(join(tmpdir(), 'prepared-review-')); roots.push(root)
  const leases = new CardLeases(root, () => clock.now), packets = new DecisionPackets(leases, () => clock.now)
  const fixtures = Array.from({ length: count }, (_, index) => {
    const fixture = preparedDecisionFixture(clock.now), card = (index + 100).toString(16).padStart(32, '0')
    // Keep all exact request/dependency meanings identical between fixture and
    // evidence while making canonical card/request identities independent.
    return transform(JSON.parse(JSON.stringify(fixture).replaceAll(fixture.cardId, card)) as typeof fixture)
  })
  for (const [index, fixture] of fixtures.entries()) await packets.publish(fixture.packet, fixture.evidence, 'fixture', `packet-${index}`)
  const evidence = vi.fn((card: string) => fixtures.find(row => row.cardId === card)!.evidence)
  const queue = vi.fn(() => ({ card_ids: fixtures.map(row => row.cardId), coverage: 'complete' as const, requests: fixtures.length }))
  const reviews = new PreparedReviews(packets, 'board', evidence, queue, () => clock.now)
  return { root, leases, packets, reviews, fixtures, evidence, queue, clock }
}
const session = (reviews: PreparedReviews, operation_id: string, caller = 'owner') => reviews.create(caller, { operation_id, label: operation_id, device: 'desktop' })

it.each(['unclaimed', 'prepared', 'generic'] as const)('keeps a Ready decision claimable through %s while its reminder is writing', async mode => {
  const { leases, packets, reviews, fixtures, root } = await setup(1)
  const fixture = fixtures[0]!, packetId = (await packets.ids())[0]!
  let finish!: () => void, began!: () => void
  const started = new Promise<void>(resolve => { began = resolve })
  const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method !== 'POST') return Response.json({})
    began()
    await new Promise<void>(resolve => { finish = resolve })
    return Response.json({ id: 'reminder' })
  })
  const notify = mainWaitNotifier({ token: 'fixture', dataSourceId: 'b'.repeat(32) }, new NotionApi(fetcher, 0), leases)
  const before = JSON.stringify(fixture), revision = leases.sourceRevision()
  const writing = notify({ id: 'owner-wait', source: 'board', kind: 'card', key: fixture.cardId, label: 'Choose', text: 'Will: choose',
    audience: 'owner', since: null, ageBasis: 'at least', url: null, fresh: true }, Date.now())
  await started
  try {
    expect(leases.pendingWrites()).toHaveLength(1)
    expect(leases.status(fixture.cardId)).toBeNull()
    expect(await packets.read(packetId, fixture.evidence)).toMatchObject({ ready: true })
    expect((await reviews.snapshot()).counts).toMatchObject({ ready: 1, leased: 0 })
    expect(leases.sourceRevision()).toBe(revision)
    if (mode !== 'unclaimed') {
      // Independent backend instances must use the durable classification too.
      const other = new CardLeases(root)
      const claim = mode === 'prepared'
        ? await reviews.claim('owner', 'Browser', { operation_id: 'during-reminder', card_id: fixture.cardId })
        : await other.claim([fixture.cardId], 'owner', 'Browser', 'during-reminder', undefined, true,
          { sourceRevision: revision, eligible: () => true })
      expect(claim).toMatchObject({ outcome: 'claimed', lease: { card_id: fixture.cardId } })
      // Reviewer source writes still wait for the reminder's per-card fence.
      await expect(withLeaseCaller('owner', claim.lease_token, () => leases.mutate(fixture.cardId, async () => {}))).rejects.toThrow('Source write unresolved')
    }
    expect(JSON.stringify(fixture)).toBe(before)
  } finally { finish(); await writing }
  expect(leases.pendingWrites()).toEqual([])
  expect(leases.sourceRevision()).toBe(revision)
  if (mode === 'unclaimed') expect(await packets.read(packetId, fixture.evidence)).toMatchObject({ ready: true })
})

it('creates only real authenticated-capability contexts; cloned contexts resume and explicit new contexts allocate independently', async () => {
  const { root, reviews, leases } = await setup()
  expect(await reviews.list('owner')).toEqual({ sessions: [] })
  const first = await session(reviews, 'tab'), second = await session(reviews, 'phone')
  expect(await session(reviews, 'tab')).toEqual(first)
  const claim = await reviews.claim('owner', 'Browser', { operation_id: 'claim', review_session_token: first.review_session_token })
  expect(claim).toMatchObject({ outcome: 'claimed', packet_version: 1 })
  expect(await reviews.claim('owner', 'Browser', { operation_id: 'clone', review_session_token: first.review_session_token })).toMatchObject({ outcome: 'held', lease: claim.lease })
  expect(await reviews.claim('owner', 'Browser', { operation_id: 'token', lease_token: claim.lease_token })).toMatchObject({ outcome: 'held', lease: claim.lease })
  const other = await reviews.claim('owner', 'Phone', { operation_id: 'other', review_session_token: second.review_session_token })
  expect(other.lease?.card_id).not.toBe(claim.lease?.card_id)
  expect((await reviews.list('owner')).sessions).toHaveLength(2)
  expect(await reviews.list('different')).toEqual({ sessions: [] })
  await expect(reviews.claim('different', 'Owner', { operation_id: 'steal', review_session_token: first.review_session_token })).rejects.toThrow('Claim lost')
  await expect(reviews.claim('rotated-caller', 'Owner', { operation_id: 'rotation', lease_token: claim.lease_token })).rejects.toThrow('Claim lost')
  expect(JSON.stringify(await reviews.list('owner'))).not.toContain(first.review_session_token)
  for (const file of await readdir(root)) expect((await readFile(join(root, file))).includes(Buffer.from(first.review_session_token))).toBe(false)
  expect(leases.status(claim.lease!.card_id)).toBeTruthy()
})

it('resumes the same token, replays lost responses across restart, and never infers a tokenless conversation from actor', async () => {
  const { root, packets, evidence, queue, reviews } = await setup()
  const first = await reviews.claim('caller', 'ChatGPT', { operation_id: 'first' })
  const restarted = new PreparedReviews(new DecisionPackets(new CardLeases(root)), 'board', evidence, queue)
  expect(await restarted.claim('caller', 'ChatGPT', { operation_id: 'first' })).toMatchObject({ lease_token: first.lease_token, lease: first.lease, packet_version: first.packet_version })
  expect(await restarted.claim('caller', 'ChatGPT', { operation_id: 'repeat', lease_token: first.lease_token })).toMatchObject({ outcome: 'held', lease: first.lease })
  const noContinuity = await restarted.claim('caller', 'ChatGPT', { operation_id: 'fresh-no-token' })
  expect(noContinuity.lease?.card_id).not.toBe(first.lease?.card_id)
  expect((await new PreparedReviews(packets, 'different-board', evidence, queue).list('caller')).sessions).toHaveLength(0)
  await expect(restarted.claim('caller', 'ChatGPT', { operation_id: 'first', card_id: noContinuity.lease!.card_id })).rejects.toThrow('different input')
})

it('shares the canonical fence with generic leases and holds a card only once across multiple exact packet requests', async () => {
  const { reviews, leases, packets, fixtures } = await setup(2)
  const f = structuredClone(fixtures[0]!)
  f.packet.binding.request_id = 'second-source-request'
  f.evidence.requests[0]!.binding!.request_id = 'second-source-request'
  await packets.publish(f.packet, f.evidence, 'fixture', 'second-request')
  fixtures[0]!.evidence.requests.push(f.evidence.requests[0]!)
  const first = await reviews.claim('caller', 'ChatGPT', { operation_id: 'first', card_id: f.cardId })
  await expect(leases.claim([f.cardId], 'generic', 'Generic', 'exact', undefined, true)).rejects.toThrow('held by')
  expect(await leases.claim(fixtures.map(f => f.cardId), 'generic', 'Generic', 'next')).toMatchObject({ lease: { card_id: fixtures[1]!.cardId } })
  expect(await reviews.claim('caller', 'ChatGPT', { operation_id: 'another', card_id: fixtures[1]!.cardId, lease_token: first.lease_token })).toMatchObject({ outcome: 'already-holding', lease: first.lease })
  await expect(reviews.claim('other', 'Other', { operation_id: 'conflict', card_id: f.cardId })).rejects.toThrow('held by')
  expect(await reviews.claim('other', 'Other', { operation_id: 'next' })).toMatchObject({ outcome: 'no-prepared-decisions' })
})

it('releases and audits without source writes; skip excludes the whole card only for its next allocation and replays that allocation', async () => {
  const { reviews, leases, fixtures } = await setup(3), s = await session(reviews, 'tab')
  const before = JSON.stringify(fixtures)
  const first = await reviews.claim('owner', 'Browser', { operation_id: 'first', review_session_token: s.review_session_token })
  const skipInput = { operation_id: 'skip', lease_token: first.lease_token, reason: 'Review another first', action: 'skip' }
  const skipped = await reviews.release('owner', 'Browser', skipInput)
  expect(skipped).toMatchObject({ outcome: 'skipped', next: { lease: { card_id: fixtures[1]!.cardId } } })
  expect(await reviews.release('owner', 'Browser', skipInput)).toMatchObject(skipped)
  expect(await reviews.claim('different', 'Other', { operation_id: 'reclaim' })).toMatchObject({ lease: { card_id: fixtures[0]!.cardId } })
  const next = await reviews.claim('owner', 'Browser', { operation_id: 'resume', review_session_token: s.review_session_token })
  await reviews.release('owner', 'Browser', { operation_id: 'release', lease_token: next.lease_token, reason: 'Close review' })
  await expect(reviews.claim('owner', 'Browser', { operation_id: 'resume', review_session_token: s.review_session_token })).rejects.toThrow('Claim lost')
  expect(JSON.stringify(fixtures)).toBe(before)
  const events = leases.readStorage(db => db.prepare("SELECT detail FROM lease_events WHERE type = 'released'").all())
  expect(JSON.stringify(events)).toContain('Review another first')
})

it('blocks stale sources, changed PR heads, durable invalidations and unavailable coverage at claim and held resume', async () => {
  const { reviews, fixtures, packets } = await setup(2)
  const first = await reviews.claim('caller', 'ChatGPT', { operation_id: 'first' })
  fixtures[0]!.evidence.requests[0]!.binding!.source_revision = 'changed'
  expect(await reviews.claim('caller', 'ChatGPT', { operation_id: 'stale-held', lease_token: first.lease_token })).toMatchObject({ outcome: 'packet-invalidated' })
  const dependency = fixtures[1]!.packet.dependencies[0]!
  await packets.invalidate(dependency, 'changed-pr-or-request-head', 'pr-head', 'fixture')
  expect(await reviews.claim('other', 'ChatGPT', { operation_id: 'next' })).toMatchObject({ outcome: 'no-ready-packet' })
  const unknown = new PreparedReviews(packets, 'other-board', () => ({ card_id: 'unknown', requests: [], reasons: ['Unavailable'], omissions: [], observed_at: null }), () => ({ card_ids: [], coverage: 'unknown', requests: null }))
  expect(await unknown.claim('other', 'ChatGPT', { operation_id: 'unknown' })).toMatchObject({ outcome: 'source-unavailable' })
})

it('fences expired tokens, allows explicit session reclaim after revalidation, and rejects old response replays', async () => {
  const clock = { now: Date.now() }, { reviews, fixtures, packets, leases } = await setup(1, clock), s = await session(reviews, 'tab')
  const first = await reviews.claim('owner', 'Browser', { operation_id: 'first', review_session_token: s.review_session_token })
  clock.now += leaseDuration + 1
  await expect(reviews.claim('owner', 'Browser', { operation_id: 'old-token', lease_token: first.lease_token })).rejects.toThrow('Claim lost')
  // New source observations and an immutable packet supersession after expiry.
  for (const dependency of fixtures[0]!.evidence.requests[0]!.dependencies) { dependency.observed_at = new Date(clock.now).toISOString(); dependency.expires_at = new Date(clock.now + 60_000).toISOString() }
  await packets.publish(fixtures[0]!.packet, fixtures[0]!.evidence, 'fixture', 'fresh-packet')
  const next = await reviews.claim('owner', 'Browser', { operation_id: 'reclaim', review_session_token: s.review_session_token })
  expect(next).toMatchObject({ outcome: 'claimed', packet_version: 2 })
  expect(next.lease!.generation).toBeGreaterThan(first.lease!.generation)
  await expect(reviews.claim('owner', 'Browser', { operation_id: 'first', review_session_token: s.review_session_token })).rejects.toThrow('Claim lost')
  await expect(withLeaseCaller('owner', first.lease_token, () => leases.mutate(fixtures[0]!.cardId, async () => {}))).rejects.toThrow('held by')
})

it.each([2, 5])('atomically allocates distinct packets across %i independent backend processes', async count => {
  const { root, fixtures } = await setup(count)
  const module = pathToFileURL(resolve('src/server/reconciliation/preparedReviews.ts')).href
  const packetsModule = pathToFileURL(resolve('src/server/reconciliation/decisionPackets.ts')).href
  const leaseModule = pathToFileURL(resolve('src/server/reconciliation/cardLeases.ts')).href
  const inputFile = join(root, 'fixtures.json')
  await writeFile(inputFile, JSON.stringify(fixtures.map(({ cardId, evidence }) => ({ cardId, evidence }))))
  const children = await Promise.all(Array.from({ length: count }, (_, i) => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { PreparedReviews } from ${JSON.stringify(module)};
    import { DecisionPackets } from ${JSON.stringify(packetsModule)};
    import { CardLeases } from ${JSON.stringify(leaseModule)};
    import { readFileSync } from 'node:fs';
    const fixtures = JSON.parse(readFileSync(${JSON.stringify(inputFile)}, 'utf8'));
    const reviews = new PreparedReviews(new DecisionPackets(new CardLeases(${JSON.stringify(root)})), 'board', card => fixtures.find(f => f.cardId === card).evidence,
      () => ({card_ids: fixtures.map(f => f.cardId), coverage: 'complete', requests: fixtures.length}));
    const result = await reviews.claim('fixture-caller', 'Fixture reviewer', {operation_id: 'process-${i}'});
    process.stdout.write(JSON.stringify({outcome: result.outcome, card: result.lease?.card_id}));
  `])))
  expect(children.map(child => JSON.parse(child.stdout).outcome)).toEqual(Array(count).fill('claimed'))
  expect(new Set(children.map(child => JSON.parse(child.stdout).card))).toEqual(new Set(fixtures.map(f => f.cardId)))
}, 30_000)

it('reserves one card without holding the database writer; ambiguous writes survive restart and require audited source reconciliation', async () => {
  const { leases, root, reviews, fixtures, clock } = await setup(2)
  const first = await leases.claim([fixtures[0]!.cardId], 'writer', 'Writer', 'write-card')
  let started!: () => void, finish!: () => void
  const began = new Promise<void>(resolve => { started = resolve }), wait = new Promise<void>(resolve => { finish = resolve })
  const write = withLeaseCaller('writer', first.lease_token, () => leases.mutate(fixtures[0]!.cardId, async () => {
    sourceWriteDispatched(); started(); await wait; throw new Error('Response timed out')
  }, { kind: 'note', marker: 'fixture-marker', text: 'fixture result' })).catch(error => error)
  await began
  const next = await reviews.claim('other', 'Other', { operation_id: 'parallel' })
  expect(next.lease?.card_id).toBe(fixtures[1]!.cardId)
  clock.now += leaseDuration + 1
  finish(); await write
  const restarted = new CardLeases(root, () => clock.now), pending = restarted.pendingWrites()[0]!
  expect(pending.card).toBe(fixtures[0]!.cardId)
  expect(await restarted.claim([pending.card], 'other', 'Other', 'blocked')).toMatchObject({ outcome: 'no-unclaimed-card' })
  await expect(restarted.ownerRelease(pending.card, first.lease!.generation, 'Cannot erase unresolved write')).resolves.toMatchObject({ outcome: 'already-released' })
  expect(await restarted.reconcileWrite(pending.card, pending.operation, 'operator', 'Transport settled; inspected full source marker history', async () => 'unknown')).toMatchObject({ outcome: 'source-unavailable' })
  expect(restarted.pendingWrites()).toHaveLength(1)
  expect(await restarted.reconcileWrite(pending.card, pending.operation, 'operator', 'Transport settled; marker found in complete readback', async intent => intent?.marker === 'fixture-marker' ? 'applied' : 'unknown')).toMatchObject({ outcome: 'reconciled', source_state: 'applied' })
  expect(await restarted.claim([pending.card], 'other', 'Other', 'after-recovery')).toMatchObject({ outcome: 'claimed' })
  expect(restarted.readStorage(db => db.prepare("SELECT * FROM lease_events WHERE type = 'write-reconciled'").all())).toHaveLength(1)
})

it('recovers a crashed process reservation through aged source marker reconciliation', async () => {
  const { root, fixtures, leases, clock } = await setup(1)
  const module = pathToFileURL(resolve('src/server/reconciliation/cardLeases.ts')).href
  const { spawn } = await import('node:child_process'), { once } = await import('node:events')
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { CardLeases, sourceWriteDispatched } from ${JSON.stringify(module)};
    const leases = new CardLeases(${JSON.stringify(root)});
    await leases.mutate(${JSON.stringify(fixtures[0]!.cardId)}, async () => {
      sourceWriteDispatched(); process.stdout.write('reserved'); await new Promise(() => {setInterval(() => {}, 1000)});
    }, {kind:'note',marker:'crash-fixture-marker'});
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture process did not reserve')), 10_000)
      child.stdout.once('data', () => { clearTimeout(timer); resolve() })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture process exited before reservation')) })
    })
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
    clock.now += leaseDuration * 10
    const pending = leases.pendingWrites()[0]!
    expect(await leases.claim([pending.card], 'other', 'Other', 'crashed-generation')).toMatchObject({ outcome: 'no-unclaimed-card' })
    await expect(leases.mutate(pending.card, async () => {})).rejects.toThrow('Source write unresolved')
    await leases.recoverStaleWrites(async (card, intent) => card === pending.card && intent?.marker === 'crash-fixture-marker' ? 'different' : 'unknown')
    expect(leases.pendingWrites()).toHaveLength(0)
    expect(leases.events()).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'write-reconciled' })]))
    expect(await leases.claim([pending.card], 'other', 'Other', 'recovered-generation')).toMatchObject({ outcome: 'claimed' })
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
})

it('distinguishes complete scoped absence, outstanding unprepared requests and unavailable sources', async () => {
  const { packets } = await setup(0)
  const evidence = (): DecisionEvidence => ({ card_id: 'unknown', requests: [], reasons: [], omissions: [], observed_at: null })
  const absent = new PreparedReviews(packets, 'absence', evidence, () => ({ card_ids: [], coverage: 'complete', requests: 0 }))
  const unprepared = new PreparedReviews(packets, 'unprepared', evidence, () => ({ card_ids: [], coverage: 'complete', requests: 4 }))
  const unavailable = new PreparedReviews(packets, 'unavailable', evidence, () => ({ card_ids: [], coverage: 'unknown', requests: null }))
  expect(await absent.claim('owner', 'Owner', { operation_id: 'none' })).toMatchObject({ outcome: 'no-decision-requests' })
  expect(await unprepared.claim('owner', 'Owner', { operation_id: 'none' })).toMatchObject({ outcome: 'no-prepared-decisions' })
  expect(await unavailable.claim('owner', 'Owner', { operation_id: 'none' })).toMatchObject({ outcome: 'source-unavailable' })
})

it('does not match tokenless claims to a similarly named explicit session creation operation', async () => {
  const { reviews } = await setup(2)
  const opened = await session(reviews, 'claim:initial')
  const held = await reviews.claim('owner', 'Owner', { operation_id: 'prior', review_session_token: opened.review_session_token })
  const independent = await reviews.claim('owner', 'Owner', { operation_id: 'initial' })
  expect(independent.lease!.card_id).not.toBe(held.lease!.card_id)
  expect(independent.session_id).not.toBe(opened.session.id)
})


it('redacts public held packets and session titles without changing exact identities or stored validation', async () => {
  const secret = 'password=example-secret'
  const { reviews, packets, fixtures } = await setup(2, { now: Date.now() }, fixture => {
    const changed = JSON.parse(JSON.stringify(fixture).replaceAll('preview', secret)) as typeof fixture
    changed.packet.title = secret
    changed.packet.background = secret
    return changed
  })
  const opened = await session(reviews, 'redaction')
  const input = { operation_id: 'claim-redaction', review_session_token: opened.review_session_token }
  const first = await reviews.claim('owner', 'Browser', input)
  for (const result of [first, await reviews.claim('owner', 'Browser', input),
    await reviews.claim('owner', 'Browser', { operation_id: 'resume-redaction', lease_token: first.lease_token })]) {
    expect(result.outcome).not.toBe('packet-invalidated')
    expect(result.lease_token).toBe(first.lease_token)
    expect(result.packet!.packet.background).not.toContain('example-secret')
    expect(result.packet!.packet.question).not.toContain('example-secret')
    expect(result.packet!.packet.binding.source_question).not.toContain('example-secret')
    expect(result.packet!.packet.binding.options).toEqual(fixtures[0]!.packet.binding.options.map(option => ({ ...option, label: option.label.replace(secret, 'password=[credential omitted]') })))
    expect(result.packet!.packet.binding.source_request).toEqual(fixtures[0]!.packet.binding.source_request)
    expect(result.packet!.packet.recommended_option_id).toBe(fixtures[0]!.packet.recommended_option_id)
  }
  expect(JSON.stringify(await reviews.list('owner'))).not.toContain('example-secret')
  expect(JSON.stringify(await session(reviews, 'redaction'))).not.toContain('example-secret')
  const stored = await packets.read(first.packet!.id, fixtures[0]!.evidence)
  expect(stored!.validation.valid).toBe(true)
  expect(stored!.packet).toEqual(fixtures[0]!.packet)
  const skip = { operation_id: 'skip-redaction', lease_token: first.lease_token, reason: 'Next', action: 'skip' }
  for (const result of [await reviews.release('owner', 'Browser', skip), await reviews.release('owner', 'Browser', skip)]) {
    expect(result.outcome).toBe('skipped')
    if (!('next' in result)) throw new Error('Skipped prepared release must include the next claim')
    expect(result.next!.packet!.packet.background).not.toContain('example-secret')
    expect(result.next!.lease_token).toBeTruthy()
  }
})

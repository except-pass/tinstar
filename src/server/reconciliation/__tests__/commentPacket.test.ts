import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mapCommentPacket, commentPacketAuthorization, commentPacketSource, commentPacketActor } from '../commentPacket'
import { commentPacketHistoryFixture, sampleCommentPacket, sampleCommentQuestion, sampleCommentOptions } from '../../../../test-fixtures/reconciliation/commentPacketHistory'
import { preparedDecisionFixture } from '../../../../test-fixtures/reconciliation/preparedDecision'
import { validateDecisionPacket } from '../../../shared/decisionPacket'
import { CardLeases } from '../cardLeases'
import { createHash } from 'node:crypto'
import { DecisionPackets } from '../decisionPackets'
import { DecisionPreparation } from '../decisionPrep'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function setup(options: Parameters<typeof commentPacketHistoryFixture>[1] = {}) {
  const root = await mkdtemp(join(tmpdir(), 'comment-packet-')); roots.push(root)
  return { ...await commentPacketHistoryFixture(root, options), root }
}
async function loaded(sources: Awaited<ReturnType<typeof setup>>['sources']) {
  await sources.preparedReviews.snapshot()
  await vi.waitFor(async () => expect((await sources.preparedReviews.snapshot()).history.every(row => row.state !== 'loading')).toBe(true), { timeout: 5000 })
  return sources.preparedReviews.snapshot()
}
function mapperFixture() {
  const { evidence } = preparedDecisionFixture()
  const request = evidence.requests[0]!
  request.binding = { ...request.binding!, request_id: 'influx-lifecycle-decision', source_question: sampleCommentQuestion, options: sampleCommentOptions }
  request.question = sampleCommentQuestion
  return { evidence, request }
}

it.each([false, true])('maps the exact sample and variant through the publication validator: variant=%s', variant => {
  const { evidence, request } = mapperFixture()
  let text = sampleCommentPacket
  if (variant) text = text.replace('Prepared packet (Tinstar Decision Prep)', 'prepared packet (tinstar decision prep)').replace('Prep job', 'job').replace('Background:', '**Context:**').replace('Options (as filed):', 'CHOICES:').replace('Recommendation:', 'Recommended option:').replace('Risk:', 'Risk / downsides:').replace('Sources:', 'Evidence:').replaceAll('\n', '\r\n')
  const mapped = mapCommentPacket({ id: 'comment-1', type: 'comment', text }, evidence)!
  expect(mapped.job_id).toBe('74fe96a2-8e5b-4045-8e27-1bbabf7d86f0')
  expect(mapped.packet.binding).toEqual(request.binding)
  expect(mapped.packet.recommended_option_id).toBe('staged-plan')
  expect(mapped.packet.risk.rating).toBe('Low')
  expect(mapped.packet.reversibility.rating).toBe('Easy')
  expect(mapped.packet.confidence).toBe('Medium')
  expect(mapped.packet.authorization).toMatchObject({ scope: commentPacketAuthorization, next_owner: 'Firstmate', next_status: 'Queued', permitted_follow_up: commentPacketAuthorization })
  expect(mapped.packet.background).toContain('87% of 100 GiB')
  expect(mapped.packet.background).toContain('Options (as prepared):')
  expect(mapped.packet.background).toContain('not read directly')
  expect(mapped.packet.uncertainty[0]).toContain('could not open the report')
  expect(mapped.packet.consequences.join(' ')).toContain('separate yes')
  expect(validateDecisionPacket(mapped.packet, evidence, Date.now())).toMatchObject({ valid: true, reasons: [] })
})

it('fills absent question/options from the source and blocks exact missing substantive fields', () => {
  const { evidence } = mapperFixture()
  const text = sampleCommentPacket.replace(/^Question:.*\n/m, '').replace(/Options \(as filed\):[\s\S]*?(?=Recommendation:)/, '').replace(/^Background:.*\n/m, '')
  const mapped = mapCommentPacket({ id: 'missing-background', type: 'comment', text }, evidence)!
  expect(mapped.packet.question).toBe(sampleCommentQuestion)
  expect(mapped.packet.binding.options).toEqual(sampleCommentOptions)
  expect(mapped.packet.recommended_option_id).toBe('staged-plan')
  expect(validateDecisionPacket(mapped.packet, evidence, Date.now()).reasons).toContain('Material evidence is unknown: Missing required field: background')
})

it('does not import another card/request, an answered request, or a body paragraph', () => {
  const { evidence, request } = mapperFixture()
  const comment = { id: 'comment', type: 'comment', text: sampleCommentPacket }
  expect(mapCommentPacket({ ...comment, type: 'paragraph' }, evidence)).toBeNull()
  expect(mapCommentPacket(comment, { ...evidence, requests: [] })).toBeNull()
  expect(mapCommentPacket({ ...comment, text: sampleCommentPacket.replace('influx-lifecycle-decision', 'another-request') }, evidence)).toBeNull()
  request.answered = true
  expect(mapCommentPacket(comment, evidence)).toBeNull()
})

it('uses the exact request question despite bot paraphrasing and refuses an unresolvable recommendation', () => {
  const { evidence } = mapperFixture()
  const text = sampleCommentPacket.replace(sampleCommentQuestion, 'An unrelated question?').replace('Recommendation: A.', 'Recommendation: Z.')
  const packet = mapCommentPacket({ id: 'bad-comment', type: 'comment', text }, evidence)!.packet
  expect(packet.question).toBe(sampleCommentQuestion)
  expect(packet.background).toContain('An unrelated question?')
  expect(validateDecisionPacket(packet, evidence, Date.now()).reasons).toEqual(['Material evidence is unknown: Missing required field: recommended_option_id'])
})

it('imports the stub Notion sample into a Ready Desk exactly once, without source writes or claims', async () => {
  const { sources, cardId, requestId, reads, jobIds } = await setup()
  const reconcile = vi.spyOn(sources.workflow, 'reconcileDecisions')
  const snapshot = await loaded(sources)
  expect(snapshot.counts.ready).toBe(1)
  expect(snapshot.pending).toContainEqual(expect.objectContaining({ card_id: cardId, request_id: requestId, state: 'Ready', reasons: [] }))
  const ids = await sources.decisionPackets.ids()
  expect(ids).toHaveLength(1)
  const stored = await sources.decisionPackets.read(ids[0]!, sources.preparationEvidence(cardId))
  expect(stored).toMatchObject({ ready: true, prepared_by: expect.stringContaining(commentPacketSource) })
  const imports = (await sources.decisionPackets.events(0, 100)).filter(event => event.type === 'comment-import')
  expect(imports).toHaveLength(1)
  expect(JSON.parse(String(imports[0]!.detail))).toMatchObject({ source: commentPacketSource, job_id: jobIds.get(cardId), comment_id: 'sample-packet-comment' })
  await sources.preparedReviews.snapshot()
  await sources.preparation.importComments(cardId, [{ id: 'sample-packet-comment', type: 'comment', text: sampleCommentPacket.replace('74fe96a2-8e5b-4045-8e27-1bbabf7d86f0', jobIds.get(cardId)!) }])
  expect(await sources.decisionPackets.ids()).toEqual(ids)
  expect(reads.every(read => read.method === 'GET' || read.path.endsWith('/query'))).toBe(true)
  expect(sources.leases.status(cardId)).toBeNull()
  expect(reconcile).not.toHaveBeenCalled()
})

it('ignores an already answered request in complete Notion history', async () => {
  const { sources } = await setup({ answered: true })
  const snapshot = await loaded(sources)
  expect(snapshot.ready).toEqual([])
  expect(snapshot.pending).toEqual([])
  expect(await sources.decisionPackets.ids()).toEqual([])
})

it('lets a newer comment supersede the old packet and renews evidence without republishing or rebinding an old comment', async () => {
  const { sources, cardId, setComments, changeRequest } = await setup()
  const initial = await loaded(sources)
  const firstId = initial.ready[0]!.id
  sources.workflow.onRecordedChange?.(cardId)
  await sources.snapshot(true)
  const renewed = await loaded(sources)
  expect(renewed, JSON.stringify(renewed)).toMatchObject({ ready: [{ id: firstId }] })
  expect(await sources.decisionPackets.ids()).toHaveLength(1)
  setComments([{ id: 'newer-comment', text: sampleCommentPacket.replace('Recommendation: A.', 'Recommendation: B.'), created_time: '2026-11-17T00:10:00Z' },
    { id: 'sample-packet-comment', text: sampleCommentPacket, created_time: '2026-11-16T23:40:00Z' }])
  sources.workflow.onRecordedChange?.(cardId)
  await sources.snapshot(true)
  const next = await loaded(sources)
  expect(next.ready).toHaveLength(1)
  expect(next.ready[0]!.id).not.toBe(firstId)
  expect(await sources.decisionPackets.read(next.ready[0]!.id, sources.preparationEvidence(cardId))).toMatchObject({ version: 2, ready: true, packet: { recommended_option_id: 'defer' } })
  expect((await sources.decisionPackets.read(firstId, sources.preparationEvidence(cardId)))!.reasons).toContain('Packet is superseded')
  changeRequest()
  sources.workflow.onRecordedChange?.(cardId)
  await sources.snapshot(true)
  const changed = await loaded(sources)
  expect(changed.ready).toEqual([])
  expect(await sources.decisionPackets.ids()).toHaveLength(2)
  expect(changed.pending[0]!.reasons).toContain('Source request, revision or exact options changed')
})

it.each([false, true])('requires a normal job for jobless or unknown-job comments: unknown=%s', async unknown => {
  const packet = unknown ? sampleCommentPacket : sampleCommentPacket.replace(/ · Prep job [a-f0-9-]+/i, '')
  const { sources, cardId, requestId, prepare } = await setup({ packet, prepare: false })
  expect(await loaded(sources)).toMatchObject({ ready: [], pending: [{ request_id: requestId, state: 'Queued' }] })
  expect(await sources.decisionPackets.ids()).toEqual([])
  const evidence = sources.preparationEvidence(cardId)
  const mapped = mapCommentPacket({ id: 'retained-comment', type: 'comment', text: packet }, evidence)!
  const job = await prepare(cardId)
  expect(job.outcome).toBe('dispatched')
  expect(await sources.preparation.publish({ job_id: job.job_id, operation_id: 'prepared-replacement', packet: mapped.packet })).toMatchObject({ ready: true })
})

it('keeps a retained comment packet reviewable against its pinned evidence without a job', async () => {
  const { sources, cardId, requestId, prepare } = await setup({ prepare: false, packet: '' })
  await loaded(sources)
  const evidence = sources.preparationEvidence(cardId)
  const { packet } = mapCommentPacket({ id: 'retained-comment', type: 'comment', text: sampleCommentPacket }, evidence)!
  const previous = await sources.decisionPackets.publish(packet, evidence, commentPacketActor, 'retained-comment')
  await sources.decisionPackets.recordEvent(commentPacketActor, 'comment-import', {}, previous.id)
  expect(await loaded(sources)).toMatchObject({ ready: [{ id: previous.id }], pending: [{ request_id: requestId, state: 'Ready' }] })
  expect(await prepare(cardId)).toMatchObject({ outcome: 'already-ready' })
})

it('shows a missing packet field as Blocked on the Desk', async () => {
  const { sources } = await setup({ packet: sampleCommentPacket.replace(/^Risk:.*\n/m, '') })
  const snapshot = await loaded(sources)
  expect(snapshot.counts.ready).toBe(0)
  expect(snapshot.pending[0]).toMatchObject({ state: 'Blocked', reasons: expect.arrayContaining(['Material evidence is unknown: Missing required field: risk']) })
})

it('imports identical comment/request IDs independently on six cards', async () => {
  const { sources, cardIds } = await setup({ cards: 6 })
  const snapshot = await loaded(sources)
  expect(snapshot.counts.ready).toBe(6)
  expect(new Set(snapshot.ready.map(packet => packet.card_id))).toEqual(new Set(cardIds))
  expect(await sources.decisionPackets.ids()).toHaveLength(6)
})

it.each([false, true])('accepts expired comment publication only without replacement: replaced=%s', async replaced => {
  const root = await mkdtemp(join(tmpdir(), 'comment-expired-job-')); roots.push(root)
  let now = Date.now()
  const { evidence, request } = mapperFixture()
  const packets = new DecisionPackets(new CardLeases(root, () => now), () => now)
  const posts: unknown[] = []
  const prep = new DecisionPreparation(packets, 'board', { candidates: () => [{ card_id: evidence.card_id, request_id: request.binding!.request_id, source_revision: request.binding!.source_revision, card_url: `https://www.notion.so/${evidence.card_id}`, card_status: 'Waiting For', answered: false, leased: false, reasons: [], rank: 0 }], coverage: () => 'complete' }, () => evidence, async () => JSON.stringify({ url: 'https://prep.example/job', key: 'fixture-key' }), () => now, async (_url, init) => { posts.push(init?.body); return new Response(null, { status: 202 }) })
  const job = await prep.prepareNow('fixture-owner', { card_id: evidence.card_id, request_id: request.binding!.request_id, reason: 'Prepare expired job proof' })
  expect(job.outcome).toBe('dispatched')
  now += 11 * 60_000
  for (const dependency of request.dependencies) { dependency.observed_at = new Date(now).toISOString(); dependency.expires_at = new Date(now + 60_000).toISOString() }
  await prep.replenish() // Expire the attempt; automatic replenishment is off.
  expect((await prep.status()).jobs[0]!.state).toBe('failed')
  if (replaced) {
    await prep.prepareNow('fixture-owner', { card_id: evidence.card_id, request_id: request.binding!.request_id, reason: 'Replace expired attempt' })
    const text = sampleCommentPacket.replace('74fe96a2-8e5b-4045-8e27-1bbabf7d86f0', job.job_id!)
    await prep.importComments(evidence.card_id, [{ id: 'replaced-job-comment', type: 'comment', text }])
    expect(await packets.ids()).toEqual([])
    expect((await prep.status()).jobs.find(row => row.id === job.job_id)).toMatchObject({ state: 'superseded' })
    return
  }
  const text = sampleCommentPacket.replace('74fe96a2-8e5b-4045-8e27-1bbabf7d86f0', job.job_id!)
  await prep.importComments(evidence.card_id, [{ id: 'expired-job-comment', type: 'comment', text }])
  expect((await prep.status()).jobs[0]).toMatchObject({ id: job.job_id, state: 'published', packet_id: expect.any(String) })
  expect(await packets.read((await packets.ids())[0]!, evidence)).toMatchObject({ ready: true })
  expect(posts).toHaveLength(1)
  expect(packets.leases.status(evidence.card_id)).toBeNull()
  const publishedAt = (await prep.status()).jobs[0]!.published_at
  await packets.leases.claim([evidence.card_id], 'reviewer', 'Reviewer', 'import-review')
  await prep.importComments(evidence.card_id, [{ id: 'expired-job-comment', type: 'comment', text }])
  expect((await prep.status()).jobs[0]).toMatchObject({ state: 'published', published_at: publishedAt, readiness: { ready: false } })
  now += 11 * 60_000
  await prep.replenish()
  expect((await prep.status()).jobs[0]).toMatchObject({ state: 'published', published_at: publishedAt, readiness: { ready: false } })
})

it('keeps withdrawn replacements retired through revalidation and restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'comment-withdrawn-job-')); roots.push(root)
  const { evidence, request } = mapperFixture()
  const packets = new DecisionPackets(new CardLeases(root))
  const source = { candidates: () => [{ card_id: evidence.card_id, request_id: request.binding!.request_id, source_revision: request.binding!.source_revision, card_url: `https://www.notion.so/${evidence.card_id}`, card_status: 'Waiting For', answered: false, leased: false, reasons: [], rank: 0 }], coverage: () => 'complete' as const }
  const make = () => new DecisionPreparation(packets, 'board', source, () => evidence, async () => JSON.stringify({ url: 'https://prep.example/job', key: 'fixture-key' }), Date.now, async () => new Response(null, { status: 202 }))
  const prep = make()
  const input = { card_id: evidence.card_id, request_id: request.binding!.request_id, reason: 'Replace withdrawn research' }
  const first = await prep.prepareNow('fixture-owner', input)
  const text = sampleCommentPacket.replace('74fe96a2-8e5b-4045-8e27-1bbabf7d86f0', first.job_id!)
  await prep.importComments(evidence.card_id, [{ id: 'first-result', type: 'comment', text }])
  const firstPacket = (await packets.read((await packets.ids())[0]!, evidence))!
  expect(firstPacket.ready).toBe(true)
  await packets.leases.writeStorage(db => db.prepare('INSERT INTO decision_packet_events(packet_id,type,actor,at,detail) VALUES(?,?,?,?,?)').run(firstPacket.id, 'research-requested', 'fixture-owner', new Date().toISOString(), '{}'))
  const second = await prep.prepareNow('fixture-owner', input)
  expect(second.outcome).toBe('dispatched')
  await prep.revalidate(evidence.card_id)
  const restarted = make()
  expect((await restarted.status()).jobs.find(job => job.id === first.job_id)).toMatchObject({ state: 'superseded', published_at: expect.any(String) })
  const result = await restarted.publish({ job_id: second.job_id, operation_id: 'replacement-result', packet: firstPacket.packet })
  expect(result.ready).toBe(true)
  await restarted.importComments(evidence.card_id, [{ id: 'late-old-result', type: 'comment', text: text.replace(/^Risk:.*$/m, 'Risk: Unknown') }])
  await expect(restarted.publish({ job_id: first.job_id, operation_id: 'late-old-direct', packet: firstPacket.packet })).rejects.toThrow('replaced')
  expect(await packets.read(result.packet_id, evidence)).toMatchObject({ ready: true })
  expect(await packets.ids()).toHaveLength(2)
  expect((await restarted.status()).jobs.find(job => job.id === first.job_id)).toMatchObject({ state: 'superseded' })
})

it('preserves explicit difficult reversibility rather than treating negation as reversible', () => {
  const { evidence } = mapperFixture()
  const text = sampleCommentPacket.replace(/^Reversibility:.*$/m, 'Reversibility: Not reversible once the archive is deleted.')
  expect(mapCommentPacket({ id: 'irreversible-comment', type: 'comment', text }, evidence)!.packet.reversibility.rating).toBe('Difficult')
})

it.each([
  ['Undo', 'Revert the scoped change and restore the previous configuration.', 'Moderate'],
  ['Rollback / undo', 'Can be rolled back before rollout.', 'Moderate'],
  ['Reversibility / undo', 'Easy to undo by reverting the PR.', 'Easy'],
  ['Undo', 'Cannot be undone after deletion.', 'Difficult'],
])('maps explicit %s wording without requiring the literal word reversible', (label, prose, rating) => {
  const { evidence } = mapperFixture()
  const text = sampleCommentPacket.replace(/^Reversibility:.*$/m, `${label}: ${prose}`)
  const packet = mapCommentPacket({ id: 'undo-comment', type: 'comment', text }, evidence)!.packet
  expect(packet.reversibility.rating).toBe(rating)
  expect(packet.reversibility.explanation).toBe(prose)
  expect(packet.material_unknowns).toEqual([])
})

it('keeps missing undo evidence blocked with the exact field', () => {
  const { evidence } = mapperFixture()
  const text = sampleCommentPacket.replace(/^Reversibility:.*$/m, 'Reversibility: The team has not assessed this yet.')
  const packet = mapCommentPacket({ id: 'unknown-undo', type: 'comment', text }, evidence)!.packet
  expect(packet.material_unknowns).toContain('Missing required field: reversibility.rating')
})

it('automatically corrects legacy imported prose questions and undo ratings after restart', async () => {
  const f = await setup()
  f.setComments([])
  await loaded(f.sources)
  const evidence = f.sources.preparationEvidence(f.cardId)
  const text = sampleCommentPacket.replace(sampleCommentQuestion, 'Approve this staged plan?').replace(/^Reversibility:.*$/m, 'Undo: Revert the scoped change and restore the previous configuration.')
  const packet = mapCommentPacket({ id: 'sample-packet-comment', type: 'comment', text }, evidence)!.packet
  packet.question = 'Approve this staged plan?'
  packet.reversibility = { rating: 'Moderate', explanation: 'Not provided in card comment: reversibility', rollback: 'Not provided in card comment: reversibility', residual_exposure: 'Not provided in card comment: reversibility' }
  packet.material_unknowns = ['Missing required field: reversibility', 'Missing required field: reversibility.rating']
  const operation = createHash('sha256').update(JSON.stringify([f.cardId, 'sample-packet-comment'])).digest('hex')
  const legacy = await f.sources.decisionPackets.publish(packet, evidence, commentPacketActor, operation)
  await f.sources.decisionPackets.recordEvent(commentPacketActor, 'comment-import', { source: commentPacketSource, card_id: f.cardId, comment_id: 'sample-packet-comment', job_id: f.jobIds.get(f.cardId) }, legacy.id)
  await f.sources.decisionPackets.validate(legacy.id, { ...evidence, reasons: ['Complete cached decision history is unavailable'] }, commentPacketActor)
  const restarted = await commentPacketHistoryFixture(f.root, { packet: text, jobIds: f.jobIds })
  expect(restarted.sources.preparationEvidence(f.cardId).reasons).toContain('Complete cached decision history is unavailable')
  const recovered = await loaded(restarted.sources)
  expect(recovered.counts.ready).toBe(1)
  const stored = await restarted.sources.decisionPackets.read(recovered.ready[0]!.id, restarted.sources.preparationEvidence(f.cardId))
  expect(stored).toMatchObject({ version: 2, ready: true, packet: { question: sampleCommentQuestion, reversibility: { rating: 'Moderate', explanation: 'Revert the scoped change and restore the previous configuration.' }, material_unknowns: [] } })
  expect(stored!.packet.binding).toEqual(legacy.packet.binding)
  expect(stored!.packet.dependencies).toEqual(legacy.packet.dependencies)
  await restarted.sources.preparedReviews.snapshot()
  expect(await restarted.sources.decisionPackets.ids()).toHaveLength(2)
})

it('automatically retries validation when source evidence recovers with unchanged cached history', async () => {
  const { sources, reads } = await setup()
  const project = sources.preparationEvidence.bind(sources)
  let unavailable = true
  vi.spyOn(sources, 'preparationEvidence').mockImplementation(card => {
    const evidence = project(card)
    return unavailable ? { ...evidence, reasons: [...evidence.reasons, 'Source properties are not loaded yet'] } : evidence
  })
  expect((await loaded(sources)).ready).toEqual([])
  const before = reads.length
  unavailable = false
  expect((await sources.preparedReviews.snapshot()).counts.ready).toBe(1)
  expect(reads).toHaveLength(before)
})

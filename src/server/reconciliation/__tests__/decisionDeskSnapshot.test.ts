import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decisionSubmitFixture } from '../../../../test-fixtures/reconciliation/decisionSubmit'
import { PreparedReviews } from '../preparedReviews'
let root: string

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })
it('projects full latest-packet counts, excludes held and invalidated cards, exposes no fictitious preparation and never writes source', async () => {
  root = await mkdtemp(join(tmpdir(), 'desk-snapshot-'))
  const fixture = decisionSubmitFixture(3), backend = await fixture.build(root)
  expect(await backend.reviews.snapshot()).toMatchObject({ counts: { ready: 3, leased: 0, preparing: 0, requests: 3 }, runner: { configured: false } })
  const session = await backend.reviews.create('owner', { operation_id: 'open', label: 'Actual session' })
  const held = await backend.reviews.claim('owner', 'Owner', { operation_id: 'claim', review_session_token: session.review_session_token })
  expect(await backend.reviews.snapshot()).toMatchObject({ counts: { ready: 2, leased: 1, preparing: 0 } })
  const invalid = fixture.fixtures[1]!
  invalid.evidence.requests[0]!.binding!.source_revision = 'changed'
  const snapshot = await backend.reviews.snapshot()
  expect(snapshot.counts).toMatchObject({ ready: 1, leased: 1, needs_repreparation: 1 })
  expect(snapshot.pending.find(row => row.card_id === invalid.cardId)?.reasons.length).toBeGreaterThan(0)
  expect(snapshot.ready.every(row => row.card_id !== held.lease!.card_id)).toBe(true)
  expect(fixture.writes).toEqual([])
})
it('marks unverifiable counts unavailable and distinguishes unknown demand from proven empty', async () => {
  root = await mkdtemp(join(tmpdir(), 'desk-snapshot-'))
  const fixture = decisionSubmitFixture(1), backend = await fixture.build(root)
  const reviews = new PreparedReviews(backend.packets, 'scope', () => fixture.fixtures[0]!.evidence, () => ({ card_ids: [], coverage: 'unknown', requests: null }))
  expect(await reviews.snapshot()).toMatchObject({ counts: { ready: null, leased: null, needs_repreparation: null, to_prepare: null, requests: null }, omissions: [expect.any(String)] })
})

it('excludes readback-confirmed requests from re-preparation even before the source observation catches up, and counts stale held research honestly', async () => {
  root = await mkdtemp(join(tmpdir(), 'desk-snapshot-'))
  const fixture = decisionSubmitFixture(3), backend = await fixture.build(root)
  const session = await backend.reviews.create('owner', { operation_id: 'open', label: 'Actual session' })
  const held = await backend.reviews.claim('owner', 'Owner', { operation_id: 'claim', review_session_token: session.review_session_token })
  const f = fixture.fixtures.find(f => f.cardId === held.lease!.card_id)!
  const revision = f.evidence.requests[0]!.binding!.source_revision
  f.evidence.requests[0]!.binding!.source_revision = 'new-source-revision'
  expect((await backend.reviews.snapshot()).counts.needs_repreparation).toBe(1)
  f.evidence.requests[0]!.binding!.source_revision = revision
  const saved = await backend.submissions.submit('owner', 'Owner', 'fixture-actor', { operation_id: 'save', lease_token: held.lease_token!, packet_id: held.packet!.id, packet_version: held.packet!.version, request_id: held.packet!.packet.binding.request_id, option_id: 'preview', next: { owner: 'Firstmate', status: 'Queued' } })
  expect(saved.outcome).toBe('recorded')
  const snapshot = await backend.reviews.snapshot()
  expect(snapshot.counts.needs_repreparation).toBe(0)
  expect(snapshot.pending.some(row => row.card_id === f.cardId)).toBe(false)
  expect(snapshot.recorded_requests).toEqual([expect.objectContaining({ card_id: f.cardId, request_id: 'preview-question' })])
})

it('reports cached source/history gaps as unavailable totals and precise failures instead of manufactured zero demand', async () => {
  root = await mkdtemp(join(tmpdir(), 'desk-snapshot-'))
  const fixture = decisionSubmitFixture(1), backend = await fixture.build(root)
  fixture.fixtures[0]!.evidence.reasons = ['Complete cached decision history is unavailable']
  fixture.fixtures[0]!.evidence.requests = []
  expect(await backend.reviews.snapshot()).toMatchObject({ coverage: 'unknown', counts: { ready: null, leased: null, preparing: 0, to_prepare: null, requests: null }, source_failures: [{ card_id: fixture.fixtures[0]!.cardId, reasons: ['Complete cached decision history is unavailable'] }] })
  expect(fixture.writes).toEqual([])
})

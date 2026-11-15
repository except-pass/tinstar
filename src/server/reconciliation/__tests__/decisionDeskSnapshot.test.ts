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

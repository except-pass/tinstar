import { describe, expect, it } from 'vitest'
import { decisionProposalSchema, currentDecisionProposal } from '../decisionProposal'
import { askReplySchema, askReturnSchema, askSelectionInputSchema } from '../ask'
import { fixtureProposal } from '../../../test-fixtures/reconciliation/decisionProposal'

describe('published decision proposals', () => {
  it('keeps the original Ask selection envelope and adds an exact return-to-request locator', () => {
    expect(askSelectionInputSchema.parse({ answer_id: '11111111-1111-4111-a111-111111111111', action_id: 'proceed', client_key: '22222222-2222-4222-a222-222222222222' })).not.toHaveProperty('instruction')
    expect(askReturnSchema.parse({ section: 'decisions', target: { kind: 'decision', id: 'exact-request' }, view: { scene: 'decisions', request_key: 'exact-request', query: 'retained search' } }).target.id).toBe('exact-request')
  })
  it('requires a real recommended member and unique actions, and reuses strict action/reference validation', () => {
    const proposal = fixtureProposal('request-a')
    expect(decisionProposalSchema.safeParse(proposal).success).toBe(true)
    for (const invalid of [
      { ...proposal, recommended_action_id: 'invented' },
      { ...proposal, actions: [proposal.actions[0], proposal.actions[0]] },
      { ...proposal, actions: [{ ...proposal.actions[0], instruction: 'https://example.com/action' }] },
      { ...proposal, references: [{ label: 'unsafe', url: 'javascript:alert(1)' }] },
      { ...proposal, references: [{ label: 'credentials', url: 'https://user:password@example.com' }] },
    ]) expect(decisionProposalSchema.safeParse(invalid).success).toBe(false)
  })
  it('preserves legacy text and adds publication data without changing freeform replies', () => {
    const reply = { summary: 'A readable answer', detail: '', references: [], suggested_actions: ['Legacy advice'] }
    expect(askReplySchema.parse(reply)).toEqual(reply)
    expect(askReplySchema.parse({ ...reply, decision_proposal: fixtureProposal('request-a') }).decision_proposal?.request_key).toBe('request-a')
  })
})

it('resolves the newest remaining typed publication with incomplete or unrelated history', () => {
  const p = { ...fixtureProposal('request'), published_at: '2026-11-10T00:00:00Z' }
  const q = { ...p, proposal_id: 'q', published_at: '2026-11-11T00:00:00Z', supersedes: p.proposal_id }
  const r = { ...q, proposal_id: 'r', published_at: '2026-11-12T00:00:00Z', supersedes: 'q' }
  const candidate = (value: unknown) => ({ value })
  expect(currentDecisionProposal([candidate(r), candidate(p), candidate(q)])?.value).toEqual(r)
  expect(currentDecisionProposal([candidate(p), candidate(r)])?.value).toEqual(r)
  expect(currentDecisionProposal([candidate(p), candidate('An explanatory answer')])?.value).toEqual(p)
  expect(currentDecisionProposal([candidate(p), candidate(undefined), candidate(q)])?.value).toEqual(q)
  const unrelated = { ...q, supersedes: null }
  expect(currentDecisionProposal([candidate(unrelated), candidate(p)])?.value).toEqual(unrelated)
  expect(currentDecisionProposal([candidate(q), candidate({ ...r, published_at: q.published_at })])?.value).toEqual({ ...r, published_at: q.published_at })
  expect(currentDecisionProposal([candidate({ ...p, supersedes: 'q' }), candidate(q)])).toBeUndefined()
  expect(currentDecisionProposal([candidate(p), candidate({ ...q, request_key: 'another' })])).toBeUndefined()
})

it('resolves equal publication timestamps independently of input order', () => {
  const work = { value: { ...fixtureProposal('request'), proposal_id: 'proposal-p', published_at: '2026-11-10T00:00:00Z' } }
  const ask = { value: { ...work.value, proposal_id: 'proposal-q', source: { kind: 'ask-reply' as const, id: 'answer-q', revision: '1' } } }
  expect(currentDecisionProposal([work, ask])).toEqual(ask)
  expect(currentDecisionProposal([ask, work])).toEqual(ask)
})

it('uses source identity to select one current proposal when IDs and publication timestamps tie', () => {
  const work = { answer_id: 'work-answer', value: { ...fixtureProposal('request'), proposal_id: 'route-v1', published_at: '2026-11-10T00:00:00Z' } }
  const ask = { answer_id: 'ask-answer', value: { ...work.value, source: { kind: 'ask-reply' as const, id: 'ask-answer', revision: '1' } } }
  for (const candidates of [[work, ask], [ask, work]]) {
    const winner = currentDecisionProposal(candidates)
    expect(winner).toEqual(ask)
    expect(candidates.filter(candidate => candidate.answer_id === winner?.answer_id)).toHaveLength(1)
  }
  const laterAnswer = { ...ask, answer_id: 'z-answer', value: { ...ask.value, source: { ...ask.value.source, id: 'z-answer' } } }
  expect(currentDecisionProposal([laterAnswer, ask])).toEqual(laterAnswer)
  expect(currentDecisionProposal([ask, laterAnswer])).toEqual(laterAnswer)
})

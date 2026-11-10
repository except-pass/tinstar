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

it('resolves one explicit typed revision chain and rejects unrelated, cyclic and cross-source publications', () => {
  const p = fixtureProposal('request'), q = { ...p, proposal_id: 'q', supersedes: p.proposal_id }, r = { ...p, proposal_id: 'r', supersedes: 'q' }
  const source = { home: '/fixture', taskId: null, kind: 'hold' as const, id: 'source' }
  const candidate = (value: unknown) => ({ value, source_request: source })
  expect(currentDecisionProposal([candidate(r), candidate(p), candidate(q)])?.value).toEqual(r)
  expect(currentDecisionProposal([candidate(p), candidate('An explanatory answer')])?.value).toEqual(p)
  expect(currentDecisionProposal([candidate(p), candidate({ ...q, supersedes: null })])).toBeUndefined()
  expect(currentDecisionProposal([candidate({ ...p, supersedes: 'q' }), candidate(q)])).toBeUndefined()
  expect(currentDecisionProposal([candidate(p), { value: q, source_request: { ...source, id: 'another' } }])).toBeUndefined()
  expect(currentDecisionProposal([candidate(p), candidate({ ...q, request_key: 'another' })])).toBeUndefined()
  expect(currentDecisionProposal([candidate(p), candidate({ ...p, rationale: 'Conflicting content' })])).toBeUndefined()
})

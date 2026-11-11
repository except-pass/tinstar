import type { DecisionProposal } from '../../src/shared/decisionProposal'
/** Deliberately inert fixture instructions. Never a production recommendation. */
export function fixtureProposal(requestKey: string, cardId?: string): DecisionProposal {
  return { schema: 'tinstar.decision-proposal.v1', proposal_id: 'fixture-proposal', request_key: requestKey, ...(cardId ? { card_id: cardId } : {}),
    question: 'Choose a fixture route?', rationale: 'Fixture evidence supports this route.', recommended_action_id: 'proceed',
    actions: [{ id: 'proceed', label: 'Proceed', instruction: 'Proceed with the fixture route' }, { id: 'defer', label: 'Not yet', instruction: 'Defer the fixture decision' }],
    references: [], source: { kind: 'firstmate-request', id: 'fixture-source', revision: '1' }, published_at: new Date().toISOString(), supersedes: null }
}

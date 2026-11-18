import type { DecisionPacket } from '../../src/shared/decisionPacket'
import { fixtureId } from './scenes'

export function preparedDecisionFixture(card_id = fixtureId(1)) {
  const packet: DecisionPacket = {
    card_id, title: 'Synthetic preview decision', source_revision: 'fixture-revision',
    summary: 'Isolated preview evidence.',
    options: [{ id: '1', label: 'Authorize preview only', next: { status: 'Queued', owner: 'Firstmate' } },
      { id: '2', label: 'Decline the preview' }],
    recommendation: 'Authorize the preview after reviewing its scope.',
    links: [{ label: 'Test evidence', url: 'https://example.com/test-evidence' }],
  }
  return { packet }
}

/** Isolated, explicitly synthetic P1 data. Never imported by production. */
import { fixtureId, fixtureSources, fixtureHomes } from './scenes'
import { projectDecisionEvidence, type CachedDecisionHistory } from '../../src/server/reconciliation/decisionEvidence'
import type { DecisionPacket } from '../../src/shared/decisionPacket'

export function preparedDecisionFixture(now = Date.now()) {
  const snapshot = fixtureSources({ now })
  const cardId = fixtureId(1), question = 'Authorize bounded preview research?'
  const sourceRequest = { home: fixtureHomes[1]!, taskId: 'linked-worker', id: 'preview-go', kind: 'decision' as const }
  const card = snapshot.intentions.data!.cards.find(card => card.id === cardId)!
  card.properties['Will action'] = { id: 'Will action', type: 'multi_select', value: ['Decision'], hasMore: false }
  card.properties['Next action'] = { id: 'Next action', type: 'rich_text', value: question, hasMore: false }
  const home = snapshot.fleet[1]!.observation.data!
  home.tasks[0]!.queue = { decisions: [{ key: 'preview-go', verb: 'needs-decision', summary: question }], completed: false, holdKind: null, originTaskId: null }
  home.backlog!.push({ id: 'preview-go', title: question, state: 'held', kind: 'ship', repo: null, hold_reason: question, hold_until: null, blocked_by: null, captain_actionable: true, pr_url: null,
    queue: { decisions: [], completed: false, holdKind: 'captain', originTaskId: 'linked-worker' }, cardReferences: [{ pageId: cardId, basis: 'explicit', source: 'fixture' }] })
  const history: CachedDecisionHistory = { observed_at: new Date(now).toISOString(), expires_at: new Date(now + 60_000).toISOString(), context: { outcome: 'available', blocks: [{
    id: 'fixture-source-note', type: 'comment', text: `Operation: request_decision\nRequested from: Will\nQuestion: ${question}\nTin Star request: ${JSON.stringify({ id: 'preview-question', action: 'Decision', preserve_action: false,
      source_request: sourceRequest, source_question: question, source_spawn_gen: 'attempt-1', options: [{ id: 'preview', label: 'Authorize preview only' }, { id: 'defer', label: 'Defer research' }] })}`,
  }] } }
  const evidence = projectDecisionEvidence(snapshot, cardId, history, now)
  const binding = evidence.requests[0]?.binding
  if (!binding) throw new Error(`Fixture binding unavailable: ${JSON.stringify(evidence)}`)
  const packet: DecisionPacket = { schema: 'tinstar.decision-packet.v1', binding: structuredClone(binding), title: 'Synthetic preview decision', question, background: 'Isolated preview evidence; no business authorization.',
    rationale: 'A bounded preview can establish API behavior without live changes.', recommended_option_id: 'preview',
    risk: { rating: 'Low', likelihood: 'Unlikely with isolated inputs', explanation: 'Only the preview is affected', blast_radius: 'One disposable preview instance' },
    reversibility: { rating: 'Easy', explanation: 'Preview records are disposable', rollback: 'Remove the isolated preview state', residual_exposure: 'No customer or device effects' },
    confidence: 'Medium', uncertainty: ['No live-source acceptance is asserted'], material_unknowns: [], consequences: ['Preview evidence only'], impacted: ['Preview operator'], prerequisites: ['An isolated config root'],
    authorization: { scope: 'Preview research only', next_owner: 'Firstmate', next_status: 'Queued', permitted_follow_up: 'Inspect preview evidence', remaining_gates: ['Separate production authorization'] },
    references: [{ label: 'Synthetic source card', url: `https://www.notion.so/${cardId}` }],
    dependencies: evidence.requests[0]!.dependencies.map(dependency => ({ kind: dependency.kind, key: dependency.key, revision: dependency.revision! })),
    invalidation_conditions: ['Changed source request or evidence'], review_within_ms: 3600_000 }
  return { snapshot, cardId, history, evidence, packet }
}

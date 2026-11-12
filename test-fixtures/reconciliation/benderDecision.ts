/** Reconstructed Bender state. No live source reads or writes. */
import { fixtureSources } from './scenes'
import { queueSignals } from '../../src/server/reconciliation/queueInputs'
export const benderCardId = '40450ce6d4228195b6a1cb3859f31336'
export const benderTaskId = 'bender-egress-pilot-decision'
export const benderQuestion = 'Go for the Bender egress-allowlist pilot? go / no-go'
export function benderDecisionSources(now = Date.now()) {
  const snapshot = fixtureSources({ now })
  const card = snapshot.intentions.data!.cards.find(card => card.id.endsWith('1'))!
  card.id = benderCardId; card.url = `https://www.notion.so/${card.id}`
  const property = (value: unknown, type = 'select') => ({ id: 'fixture', type, value, hasMore: false })
  Object.assign(card.properties, {
    Name: property('Farm CI: restrict workload VM office-network access to an allowlist'),
    Status: property('Queued'), Owner: property('Firstmate'), 'Will action': property(['Decision'], 'multi_select'),
    'Waiting For': property('Queued behind the KD and CI work (Will, 2026-10-25). Do not drop.', 'rich_text'),
    'First Mate tasks': property(JSON.stringify({ schema: 'tinstar.fm-links.v1', tasks: [
      { fm_home: '/fixture/hulk', task_id: benderTaskId, first_observed_spawn_gen: 'attempt-1' },
    ] }), 'rich_text'),
  })
  snapshot.intentions.data!.cards = [card]
  const home = snapshot.fleet[1]!, task = home.observation.data!.tasks[0]!
  task.id = task.identity.task_id = benderTaskId; task.cardReferences = []
  Object.assign(task, queueSignals({ hints: { open_decisions: [{ key: 'pilot-go', verb: 'needs-decision', summary: benderQuestion }] } }))
  home.observation.data!.tasks = [task]
  // The task's plan/hold record is distinct from its keyed needs-decision.
  home.observation.data!.backlog = [{ id: benderTaskId, title: 'Bender pilot plan line', state: 'held', kind: 'ship', repo: null,
    hold_reason: benderQuestion, hold_until: null, blocked_by: null, captain_actionable: true, pr_url: null, cardReferences: [],
    ...queueSignals({ hold_kind: 'captain', body_lines: [`Origin: ${benderTaskId}`] }),
  }]
  snapshot.fleet = [home]
  return snapshot
}

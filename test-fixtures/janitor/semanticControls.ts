import { fixtureId, fixtureSources } from '../reconciliation/scenes'
import type { AuditInput } from '../../src/server/janitor/report'

/** SYNTHETIC positive controls, never live-board evidence.
 * Copies the existing card/snapshot structure with invented IDs, example PRs and paraphrased prose.
 * Expected labels are authored here before inference and measured separately from the live sample.
 */
export function syntheticJanitorControls(at: string): { input: AuditInput; cases: Array<{ pageIds: string[]; expected: 'possible_duplicate'; note: string }> } {
  const snapshot = fixtureSources({ now: Date.parse(at) })
  snapshot.fleet = []
  snapshot.scope = 'SYNTHETIC janitor positive controls; not live operational evidence'
  snapshot.warnings = ['SYNTHETIC fixture: invented work and page IDs; never report this as live board evidence']
  const definitions = [
    { titles: ['Keep selected search depth in shared sizing reports', 'Shared sizing reports keep selected search depth'],
      bodies: ['Persist maxEvaluations through the shared-report contract and reader. Acceptance: opening the report shows the selected search depth.',
        'Retain the selected maxEvaluations value in the shared report reader and contract. Verify the saved report displays that search depth.'] },
    { titles: ['Retry agreement requests with bounded exponential backoff', 'Bounded exponential backoff to retry agreement requests'],
      bodies: ['Retry agreement reads with exponential backoff, jitter and a cap; failed requests must not cause a retry storm.',
        'Add capped retries with jitter and exponential delays to agreement reads, avoiding repeated rapid requests after errors.'] },
    { titles: ['Preserve ink drawing beside refined result', 'Refined result beside preserved ink drawing'],
      bodies: ['Keep the original ink visible while placing the refinement beside it. Undo removes the refinement and preserves original strokes.',
        'Display refined output next to the original strokes. Undo the refined output without removing the original drawing.'] },
    { titles: ['Cache principal access checks for portfolio load', 'Portfolio load cache for principal access checks'],
      bodies: ['Cache principal access-check results for a portfolio load so each run card reuses the same access decision.',
        'Reuse a cached access decision per principal across the cards of one portfolio load rather than checking every card independently.'] },
  ]
  const cards = definitions.flatMap((definition, pair) => definition.titles.map((name, index) => {
    const id = fixtureId(8000 + pair * 2 + index)
    const values = { Name: `SYNTHETIC: ${name}`, Owner: 'Synthetic reviewer', Status: 'In Progress',
      'Next action': 'SYNTHETIC: review this duplicate control; no real board action',
      'Next check-in': { start: at }, 'Parent item': [], 'Sub-item': [],
      Link: `https://github.com/example/synthetic-janitor-controls/pull/${pair + 1}` }
    return { id, url: `https://www.notion.so/${id}`, archived: false, in_trash: false, last_edited_time: at,
      properties: Object.fromEntries(Object.entries(values).map(([field, value]) => [field, { id: field,
        type: field === 'Name' ? 'title' : field === 'Status' || field === 'Owner' ? 'select' : field === 'Link' ? 'url' :
          field === 'Next check-in' ? 'date' : ['Parent item', 'Sub-item'].includes(field) ? 'relation' : 'rich_text', value, hasMore: false }])) }
  }))
  snapshot.intentions.data!.cards = cards
  snapshot.intentions.data!.schema = {}
  snapshot.intentions.data!.scope = snapshot.scope
  const contexts = Object.fromEntries(cards.map((card, index) => [card.id, { outcome: 'available' as const, observedAt: at,
    blocks: [{ id: fixtureId(9000 + index), type: 'paragraph', text: `SYNTHETIC CONTROL - not a live card. ${definitions[Math.floor(index / 2)]!.bodies[index % 2]}` }] }]))
  return { input: { snapshot, contexts }, cases: definitions.map((_, pair) => ({ pageIds: [fixtureId(8000 + pair * 2), fixtureId(8001 + pair * 2)],
    expected: 'possible_duplicate', note: 'SYNTHETIC: same invented work/PR and equivalent paraphrased acceptance; not live-board ground truth' })) }
}

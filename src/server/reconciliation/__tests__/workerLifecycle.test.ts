import { describe, expect, it } from 'vitest'
import { fixtureSources, fixtureId } from '../../../../test-fixtures/reconciliation/scenes'
import { parseDispatchProvenance } from '../dispatchProvenance'
import { SceneReconciler } from '../scene'
import { buildWorkerLinkReport } from '../workerLinkReport'
import { executionWarnings } from '../workflowViews'
import { TERMINAL_BACKLOG_GRACE_MS } from '../workerLifecycle'

const now = Date.parse('2026-11-16T16:00:00Z'), cardId = fixtureId(1)
function fixture() {
  const source = fixtureSources({ now })
  source.fleet = [source.fleet[1]!]
  const home = source.fleet[0]!, task = home.observation.data!.tasks[0]!
  home.observation.data!.tasks = [task]
  home.observation.data!.backlog = [{ ...home.observation.data!.backlog![0]!, id: task.identity.task_id!,
    dispatchProvenance: parseDispatchProvenance([`card: ${cardId}`]), cardReferences: [] }]
  return { source, home, task, row: home.observation.data!.backlog[0]!, card: source.intentions.data!.cards.find(card => card.id === cardId)! }
}
const findings = (source: ReturnType<typeof fixture>['source'], detector: string) =>
  buildWorkerLinkReport(source).findings.filter(finding => finding.detector === detector)
const reconcileScene = (source: ReturnType<typeof fixture>['source'], at: number) => new SceneReconciler().project(source, at)

describe('spawn card exceptions', () => {
  it.each([
    ['missing', undefined, 'missing coordinator-authored'],
    ['none', ['card: none'], 'card: none'],
    ['malformed', ['card: invalid'], 'malformed or conflicting'],
    ['unknown', [`card: ${fixtureId(9999)}`], 'unknown card'],
    ['archived', [`card: ${cardId}`], 'archived/Done'],
    ['Done', [`card: ${cardId}`], 'archived/Done'],
  ])('flags %s immediately in report, scene and First Mate work-view exceptions and clears on correction', (kind, lines, reason) => {
    const { source, row, card, task } = fixture()
    row.dispatchProvenance = parseDispatchProvenance(lines)
    if (kind === 'archived') card.archived = true
    if (kind === 'Done') card.properties.Status!.value = 'Done'
    const before = JSON.stringify(source)
    const report = findings(source, 'invalid-dispatch-card')
    expect(report).toHaveLength(1)
    expect(report[0]).toMatchObject({ homeIds: ['/fixture/hulk'], reason: expect.stringContaining(reason) })
    expect(report[0]!.reason).toContain('task_id=linked-worker spawn_gen=attempt-1')
    const scene = reconcileScene(source, now)
    expect(scene.findings.filter(f => f.workerLinkDetectors?.includes('invalid-dispatch-card'))).toHaveLength(1)
    expect(executionWarnings(scene, now).filter(w => w.executionId && w.reasons.includes(report[0]!.reason))).toHaveLength(1)
    expect(JSON.stringify(source)).toBe(before) // The report cannot repair either source.
    row.dispatchProvenance = parseDispatchProvenance([`card: ${cardId}`])
    card.archived = false; card.properties.Status!.value = 'In Progress'
    expect(findings(source, 'invalid-dispatch-card')).toEqual([])
    expect(task.cardReferences).not.toEqual([]) // Legacy metadata did not suppress the exception.
  })

  it('deduplicates mirrored backlog lines, without accepting conflicting mirrors or repeated declarations', () => {
    const { source, row, task } = fixture()
    task.dispatchProvenance = row.dispatchProvenance
    expect(findings(source, 'invalid-dispatch-card')).toEqual([])
    task.dispatchProvenance = parseDispatchProvenance(['card: none'])
    expect(findings(source, 'invalid-dispatch-card')).toHaveLength(1)
    row.dispatchProvenance = parseDispatchProvenance([`card: ${cardId}`, `card: ${cardId}`])
    expect(findings(source, 'invalid-dispatch-card')).toHaveLength(1)
  })

  it('does not claim a card is unknown from stale, paginated or incomplete board reads', () => {
    for (const mode of ['stale', 'partial', 'pagination']) {
      const { source, row } = fixture()
      row.dispatchProvenance = parseDispatchProvenance([`card: ${fixtureId(9999)}`])
      if (mode === 'stale') source.intentions.status = 'stale'
      if (mode === 'partial') source.intentions.coverage = 'partial'
      if (mode === 'pagination') source.intentions.data!.hasMore = true
      expect(findings(source, 'invalid-dispatch-card')).toEqual([])
    }
  })

  it('still flags a missing line when the board is unavailable, and excludes stale homes, second mates and closed rows', () => {
    const { source, row, task, home } = fixture()
    row.dispatchProvenance = parseDispatchProvenance(undefined)
    source.intentions.status = 'unknown'; source.intentions.data = null
    expect(findings(source, 'invalid-dispatch-card')).toHaveLength(1)
    home.observation.status = 'stale'
    expect(findings(source, 'invalid-dispatch-card')).toEqual([])
    home.observation.status = 'fresh'; task.kind = 'secondmate'
    expect(findings(source, 'invalid-dispatch-card')).toEqual([])
    task.kind = 'ship'; row.state = 'done'
    expect(findings(source, 'invalid-dispatch-card')).toEqual([])
  })
})

describe('terminal in-flight exceptions', () => {
  it.each(['done', 'failed'])('flags %s only after the grace, clears on row closure, and never edits the backlog', status => {
    const { source, row, task } = fixture()
    task.lastEventText = `${status} [at=${(now - TERMINAL_BACKLOG_GRACE_MS) / 1000}]: finished`
    expect(findings(source, 'terminal-in-flight')).toEqual([])
    task.lastEventText = `${status} [at=${(now - TERMINAL_BACKLOG_GRACE_MS - 1000) / 1000}]: finished`
    expect(findings(source, 'terminal-in-flight')).toHaveLength(1)
    expect(findings(source, 'terminal-in-flight')[0]!.reason).toContain('home=/fixture/hulk task_id=linked-worker spawn_gen=attempt-1')
    expect(findings(source, 'terminal-in-flight')[0]!.reason).toContain('close it in its home backlog')
    expect(executionWarnings(reconcileScene(source, now), now).some(w => w.title.includes('Close home backlog'))).toBe(true)
    expect(row.state).toBe('in_flight')
    row.state = 'done'
    expect(findings(source, 'terminal-in-flight')).toEqual([])
  })

  it('uses snapshot-relative status age when no at token is published; ignores unknown age and nonterminal latest status', () => {
    const { source, task } = fixture()
    task.last_event.state = 'failed'; task.last_event.age_seconds = 901
    expect(findings(source, 'terminal-in-flight')).toHaveLength(1)
    task.last_event.age_seconds = 899
    expect(findings(source, 'terminal-in-flight')).toEqual([])
    task.last_event.age_seconds = null
    expect(findings(source, 'terminal-in-flight')).toEqual([])
    task.last_event.age_seconds = 3600
    task.lastEventText = 'working [at=1]: resumed after failure'
    expect(findings(source, 'terminal-in-flight')).toEqual([])
  })

  it('keeps missing-card and terminal backlog exceptions independent and stable across reads', () => {
    const { source, task, row } = fixture()
    row.dispatchProvenance = parseDispatchProvenance(['card: none'])
    task.last_event.state = 'done'; task.last_event.age_seconds = 3600
    const first = buildWorkerLinkReport(source)
    expect(buildWorkerLinkReport(source)).toEqual(first)
    expect(findings(source, 'invalid-dispatch-card')).toHaveLength(1)
    expect(findings(source, 'terminal-in-flight')).toHaveLength(1)
    row.dispatchProvenance = parseDispatchProvenance([`card: ${cardId}`])
    expect(findings(source, 'invalid-dispatch-card')).toEqual([])
    expect(findings(source, 'terminal-in-flight')).toHaveLength(1)
  })
})

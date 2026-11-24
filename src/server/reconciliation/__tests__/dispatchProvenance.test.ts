import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseDispatchProvenance, collectedDispatch, dispatchForTask } from '../dispatchProvenance'
import { fleetObservation } from '../fleet'
import { buildWorkerLinkReport } from '../workerLinkReport'
import { fixtureId, fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { WORKER_LINK_SCHEMA } from '../workerLinks'
import { reconcileScene } from '../scene'
import { tswProjectId, tswSnapshot, tswEvidence } from '../tswSnapshot'
import { runWorkerLinkAdapter } from '../../../coordinator/workerLinkAdapter'

const now = Date.parse('2026-11-05T12:00:00Z'), a = fixtureId(1), b = fixtureId(2)
const jiraKey = 'TSW-987654321'
const jiraId = `jira:example.atlassian.net:${tswProjectId}:987654321`
export function dispatchSource() {
  const input = fixtureSources({ now })
  input.fleet = [input.fleet[1]!]
  const home = input.fleet[0]!
  home.observation.data!.tasks = [home.observation.data!.tasks[0]!]
  home.observation.data!.backlog = []
  home.observation.data!.tasks[0]!.dispatchProvenance = parseDispatchProvenance([`card: ${a}`], 'task.backlog.body_lines')
  input.intentions.data!.cards = input.intentions.data!.cards.filter(c => c.id === a)
  input.intentions.data!.cards[0]!.properties['First Mate tasks']!.value = JSON.stringify({ schema: WORKER_LINK_SCHEMA, tasks: [] })
  return input
}
const tier = (input: ReturnType<typeof dispatchSource>) => buildWorkerLinkReport(input).homes[0]!.tiers

describe('coordinator backlog dispatch line', () => {
  it.each([
    [[`card: ${a}`], 'card'],
    [[`card: ${jiraKey}`], 'card'],
    [[`card: ${jiraKey}`, `card: ${jiraKey}`], 'conflict'],
    [[`card: ${jiraKey}`, `card: ${a}`], 'conflict'],
    [[`card: ${jiraId}`], 'conflict'],
    [['card: 987654321'], 'conflict'],
    [['card: TSW-01'], 'conflict'],
    [['card: tsw-987654321'], 'conflict'],
    [['card: 40f50ce6-d422-81b0-8375-d793820e2e40'], 'card'],
    [['card: none'], 'independent'],
    [[`card: ${a}`, `card: ${a}`], 'conflict'],
    [[`card: ${a}`, 'card: none'], 'conflict'],
    [['card: xyz'], 'conflict'],
    [[`card:${a}`], 'conflict'],
    [[` card: ${a}`], 'conflict'],
    [[`card: ${a} `], 'conflict'],
    [['card: 40f50ce6--d42281b08375d793820e2e40'], 'conflict'],
    [[`Card: ${a}`, `https://app.notion.com/p/${a}`, `card ${a}`], 'absent'],
    [undefined, 'absent'],
    [[2], 'conflict'],
  ])('parses %j as %s without publishing prose', (lines, status) => {
    expect(parseDispatchProvenance(lines).status).toBe(status)
    expect(JSON.stringify(parseDispatchProvenance(lines))).not.toContain('https://')
  })
  it('normalizes dashed ids and combines mirrored notes without hiding conflicting notes', () => {
    expect(parseDispatchProvenance(['card: 40F50CE6-D422-81B0-8375-D793820E2E40'])).toMatchObject({ cardId: '40f50ce6d42281b08375d793820e2e40' })
    const task = { dispatchProvenance: parseDispatchProvenance([`card: ${a}`]) }
    expect(dispatchForTask(task, task).status).toBe('card')
    expect(dispatchForTask(task, { dispatchProvenance: parseDispatchProvenance([`card: ${b}`]) }).status).toBe('conflict')
  })
  it('keeps status coordinator declarations scoped to TSW', () => {
    expect(tswSnapshot({ body_lines: [`card: ${jiraKey}`] }, 'fixture')[tswEvidence]?.dispatchProvenance)
      .toMatchObject({ status: 'card', cardId: jiraKey })
    expect(tswSnapshot({ body_lines: [`card: ${a}`] }, 'fixture')[tswEvidence]?.dispatchProvenance.status).toBe('conflict')
  })
  it('collects identifiers from snapshot backlog lines, never the note prose', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tinstar-dispatch-'))
    try {
      const file = join(dir, 'snapshot.json')
      await writeFile(file, JSON.stringify({ schema: 'fm-fleet-snapshot.v1', fm_home: '/fixture/home', generated: new Date().toISOString(),
        main_inventory: { valid: true },
        tasks: [{ id: 'worker', spawn_gen: 'g', backlog: { id: 'worker', body_lines: ['secret prose', `card: ${a}`] } }],
        backlog: { present: true, records: [{ id: 'worker', body_lines: ['secret prose', `card: ${a}`] }] } }))
      const result = await fleetObservation({ home: '/fixture/home', snapshotFile: file }).get()
      expect(result).toMatchObject({ status: 'fresh', coverage: 'complete', data: {
        tasks: [{ dispatchProvenance: { status: 'card', cardId: a } }], backlog: [{ dispatchProvenance: { status: 'card', cardId: a } }],
      } })
      expect(JSON.stringify(result)).not.toContain('secret prose')
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})

describe('shared eligible auto-write classification', () => {
  it('links an observed Jira card through the exact dispatch declaration without proposing a Notion write', async () => {
    const input = dispatchSource(), task = input.fleet[0]!.observation.data!.tasks[0]!
    const source = 'task.backlog.body_lines'
    Object.assign(task, collectedDispatch({ body_lines: [`card: ${jiraKey}`] }, source))
    task.cardReferences = []
    const card = structuredClone(input.intentions.data!.cards[0]!)
    card.id = jiraId
    card.source = { provider: 'jira', instanceId: 'https://example.atlassian.net', collectionId: tswProjectId,
      itemId: '987654321', displayKey: jiraKey, synthetic: false }
    delete card.properties['First Mate tasks']
    card.properties.Status!.value = 'In Progress'
    input.intentions.data!.cards.push(card)
    const { data: _data, ...coverage } = input.intentions
    const jira = { ...coverage, source: 'jira' }
    input.intentions.sources = [{ ...coverage, source: 'notion' }, jira]

    expect(task.dispatchProvenance).toEqual({ status: 'card', cardId: jiraKey, sources: [source] })
    const scene = reconcileScene(input, now)
    expect(scene.claims).toContainEqual(expect.objectContaining({ cardId: jiraId, identity: task.identity,
      verification: 'confirmed', state: 'current', sources: [source] }))
    expect(scene.cardRollups.find(row => row.cardId === jiraId)?.counts.running).toBe(1)
    const result = await runWorkerLinkAdapter(input, { now: () => now, audit: async () => {} })
    expect(result.report.findings).toContainEqual(expect.objectContaining({ detector: 'confirmed-link', cardIds: [jiraId] }))
    expect(result.report.findings.some(f => f.detector === 'invalid-dispatch-card')).toBe(false)
    expect(result.report.homes[0]!.tiers['already confirmed']).toMatchObject([{ cardIds: [jiraId], sources: [source] }])
    expect(result.report.merges).toEqual([])
    expect(result.plannedWrites).toEqual([])

    jira.status = 'stale'
    expect(tier(input).unavailable).toMatchObject([{ cardIds: [jiraId] }])
    expect(buildWorkerLinkReport(input).findings).not.toContainEqual(expect.objectContaining({ detector: 'invalid-dispatch-card' }))

    Object.assign(task, collectedDispatch({ body_lines: [`card: ${a}`] }, source))
    expect(tier(input)['eligible auto-write']).toMatchObject([{ cardIds: [a] }])

    input.intentions.data!.cards.pop()
    Object.assign(task, collectedDispatch({ body_lines: [`card: ${jiraKey}`] }, source))
    expect(tier(input).unavailable).toMatchObject([{ cardIds: [jiraKey] }])
    expect(buildWorkerLinkReport(input).findings).not.toContainEqual(expect.objectContaining({ detector: 'invalid-dispatch-card' }))
  })
  it('emits exact dispatch proposals in the existing report without confirming a scene edge', () => {
    const input = dispatchSource(), report = buildWorkerLinkReport(input)
    expect(report.dispatchProvenance.status).toBe('collected')
    expect(tier(input)['eligible auto-write'][0]?.proposals).toEqual([{
      cardId: a, fm_home: '/fixture/hulk', task_id: 'linked-worker', spawn_gen: 'attempt-1',
      strength: 'dispatch-ledger', sources: ['task.backlog.body_lines'],
    }])
    expect(report.merges[0]?.properties?.['First Mate tasks'].rich_text).toHaveLength(1)
    expect(report.homes[0]!.counts['already confirmed']).toBe(0)
  })
  it.each(['stale-home', 'partial-home', 'partial-notion', 'pagination', 'unknown-worker', 'finished-worker', 'manager', 'competing', 'generation', 'unknown-property', 'malformed-line', 'missing-card', 'done-card', 'contradictory-reference', 'duplicate-attempt'])(
    'suppresses automatic authority for %s', condition => {
      const input = dispatchSource(), home = input.fleet[0]!, task = home.observation.data!.tasks[0]!, cards = input.intentions.data!.cards
      if (condition === 'stale-home') home.observation.status = 'stale'
      if (condition === 'partial-home') home.observation.coverage = 'partial'
      if (condition === 'partial-notion') input.intentions.status = 'partial'
      if (condition === 'pagination') input.intentions.data!.hasMore = true
      if (condition === 'unknown-worker') { task.endpoint.agent_alive = null; task.endpoint.exists = null; task.current_state.state = 'unknown'; task.last_event.state = null }
      if (condition === 'finished-worker') task.lastEventText = 'done [at=1]: completed'
      if (condition === 'manager') task.kind = 'secondmate'
      if (condition === 'competing' || condition === 'generation') {
        const card = structuredClone(cards[0]!)
        if (condition === 'competing') card.id = b
        card.properties['First Mate tasks']!.value = JSON.stringify({ schema: WORKER_LINK_SCHEMA, tasks: [{ fm_home: task.identity.fm_home,
          task_id: task.identity.task_id, first_observed_spawn_gen: condition === 'generation' ? 'old' : task.identity.spawn_gen }] })
        cards.push(card)
      }
      if (condition === 'unknown-property') { const card = structuredClone(cards[0]!); card.id = b; delete card.properties['First Mate tasks']; cards.push(card) }
      if (condition === 'malformed-line') task.dispatchProvenance = parseDispatchProvenance(['card: invalid'])
      if (condition === 'missing-card') cards.length = 0
      if (condition === 'done-card') cards[0]!.properties.Status!.value = 'Done'
      if (condition === 'contradictory-reference') task.cardReferences.push({ pageId: b, basis: 'textual', source: 'task.raw' })
      if (condition === 'duplicate-attempt') home.observation.data!.tasks.push({ ...structuredClone(task), identity: { ...task.identity, spawn_gen: 'other' } })
      expect(tier(input)['eligible auto-write']).toEqual([])
    })
  it('reports intentional independence and malformed declarations in the right tiers', () => {
    const input = dispatchSource(), task = input.fleet[0]!.observation.data!.tasks[0]!
    task.cardReferences = []
    task.dispatchProvenance = parseDispatchProvenance(['card: none'])
    expect(tier(input).independent).toHaveLength(1)
    task.dispatchProvenance = parseDispatchProvenance(['card: bad'])
    expect(tier(input).conflicts).toHaveLength(1)
  })
})

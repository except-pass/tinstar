import { describe, expect, it, vi } from 'vitest'
import { fixtureSources, fixtureId } from '../../../../test-fixtures/reconciliation/scenes'
import { BACKFILL_TIERS, buildWorkerLinkReport } from '../workerLinkReport'
import { reconcileScene } from '../scene'
import { notionObservation } from '../notion'
import { cardReferences } from '../references'
import { BLANK_PROPERTY_REASON, MAX_WORKER_LINK_CHARS, parseWorkerLinks, readWorkerLinks, WORKER_LINK_SCHEMA, type WorkerLink } from '../workerLinks'

const now = Date.parse('2026-11-05T12:00:00Z'), a = fixtureId(1), b = fixtureId(2)
function source() {
  const input = fixtureSources({ now })
  input.fleet = [input.fleet[1]!]
  input.intentions.data!.cards = input.intentions.data!.cards.filter(c => c.id === a)
  input.fleet[0]!.observation.data!.tasks = [input.fleet[0]!.observation.data!.tasks[0]!]
  input.fleet[0]!.observation.data!.backlog = []
  input.intentions.data!.cards[0]!.properties['First Mate tasks']!.value = JSON.stringify({ schema: WORKER_LINK_SCHEMA, tasks: [] })
  return input
}
const proposals = (input: ReturnType<typeof source>) => buildWorkerLinkReport(input).homes.flatMap(home => home.tiers.ambiguous.flatMap(row => row.proposals))
function link(input: ReturnType<typeof source>, overrides = {}): WorkerLink {
  const identity = input.fleet[0]!.observation.data!.tasks[0]!.identity
  return { fm_home: identity.fm_home, task_id: identity.task_id!, first_observed_spawn_gen: identity.spawn_gen!, ...overrides }
}
function declare(input: ReturnType<typeof source>, tasks: WorkerLink[]) {
  input.intentions.data!.cards[0]!.properties['First Mate tasks']!.value = JSON.stringify({ schema: WORKER_LINK_SCHEMA, tasks })
}
const notionResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
/** Property object produced by the Notion wire reader, including its workerLinks classification. */
async function readTasksProperty(property: Record<string, unknown>) {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(notionResponse({ object: 'data_source', properties: { Name: { id: 'title', type: 'title' } } }))
    .mockResolvedValueOnce(notionResponse({ has_more: false, results: [{
      object: 'page', id: a, last_edited_time: '2026-11-05T12:00:00.000Z',
      properties: { 'First Mate tasks': { id: 'links', type: 'rich_text', ...property } },
    }] }))
  const result = await notionObservation({ token: 'secret', dataSourceId: a }, fetcher).get()
  const read = result.data?.cards[0]?.properties['First Mate tasks']
  if (!read?.workerLinks) throw new Error('reader did not return First Mate tasks')
  return read
}

describe('read-only backfill proposals', () => {
  it.each([
    [{ notion_page_id: a }, 'task.notion_page_id', 'legacy-metadata'],
    [{ work_item: `https://app.notion.com/p/${a}` }, 'task.work_item', 'legacy-metadata'],
    [{ raw: `Private brief https://www.notion.so/${a}` }, 'task.raw', 'textual-reference'],
    [{ title: `Investigate card ${a}` }, 'task.title', 'textual-reference'],
  ])('records supported source evidence without leaking prose (%j)', (metadata, field, strength) => {
    const input = source()
    input.fleet[0]!.observation.data!.tasks[0]!.cardReferences = cardReferences(metadata, 'task')
    expect(proposals(input)).toEqual([{ cardId: a, fm_home: '/fixture/hulk', task_id: 'linked-worker', spawn_gen: 'attempt-1', sources: [field], strength }])
    expect(JSON.stringify(buildWorkerLinkReport(input))).not.toContain('Private brief')
  })
  it('collects task and matching backlog evidence, but rejects equal-title-only hints', () => {
    const input = source(), task = input.fleet[0]!.observation.data!.tasks[0]!
    input.fleet[0]!.observation.data!.backlog = [{ id: task.identity.task_id, title: 'brief', state: 'in_flight', kind: 'ship', repo: null,
      hold_reason: null, hold_until: null, blocked_by: null, captain_actionable: null, pr_url: null,
      cardReferences: cardReferences({ raw: `card ${a}`, notion_page_id: a }, 'backlog') }]
    expect(proposals(input)[0]?.sources).toEqual(['backlog.notion_page_id', 'backlog.raw', 'task.notion_page_id'])
    task.cardReferences = []
    input.fleet[0]!.observation.data!.backlog = []
    task.backlog.title = input.intentions.data!.cards[0]!.properties.Name!.value as string
    expect(proposals(input)).toEqual([])
  })
  it.each(['stale', 'partial', 'unknown'] as const)('skips a %s home and exposes unknown coverage', status => {
    const input = source()
    input.fleet[0]!.observation.status = status
    input.fleet[0]!.observation.coverage = status === 'partial' ? 'partial' : 'unknown'
    const report = buildWorkerLinkReport(input)
    expect(proposals(input)).toEqual([])
    expect(report.findings.some(f => f.detector === 'unknown-coverage')).toBe(true)
    expect(report.findings.some(f => f.detector === 'declared-absent')).toBe(false)
  })
  it('skips declared workers on any card, ambiguous candidates and unreadable declarations', () => {
    const input = source()
    declare(input, [link(input)])
    expect(proposals(input)).toEqual([])
    const other = structuredClone(input.intentions.data!.cards[0]!)
    other.id = b
    input.intentions.data!.cards.push(other)
    declare(input, [])
    expect(proposals(input)).toEqual([])
    input.intentions.data!.cards.pop()
    input.fleet[0]!.observation.data!.tasks[0]!.cardReferences.push({ pageId: b, basis: 'textual', source: 'backlog.raw' })
    expect(proposals(input)).toEqual([])
    input.fleet[0]!.observation.data!.tasks[0]!.cardReferences.pop()
    input.intentions.data!.cards[0]!.properties['First Mate tasks']!.value = '{'
    expect(proposals(input)).toEqual([])
    delete input.intentions.data!.cards[0]!.properties['First Mate tasks']
    expect(proposals(input)).toEqual([])
  })
  it('keeps stale Notion, pagination gaps, filtered/missing cards and truncated properties unknown', () => {
    for (const mutate of [
      (input: ReturnType<typeof source>) => { input.intentions.status = 'stale' },
      (input: ReturnType<typeof source>) => { input.intentions.status = 'partial'; input.intentions.data!.hasMore = true },
      (input: ReturnType<typeof source>) => { input.intentions.data!.cards = [] },
      (input: ReturnType<typeof source>) => { input.intentions.data!.cards[0]!.properties['First Mate tasks']!.hasMore = true },
      (input: ReturnType<typeof source>) => { input.fleet[0]!.observation.status = 'unknown'; input.fleet[0]!.observation.data = null },
    ]) {
      const input = source()
      mutate(input)
      expect(proposals(input)).toEqual([])
      expect(buildWorkerLinkReport(input).findings.some(f => f.detector === 'declared-absent')).toBe(false)
    }
  })
  it('never initializes an unreadable wire property that normalized to blank text', () => {
    const input = source(), property = input.intentions.data!.cards[0]!.properties['First Mate tasks']!
    property.value = ''
    property.workerLinks = readWorkerLinks({ type: 'rich_text', rich_text: [{}] })
    expect(property.workerLinks.status).toBe('unknown')
    expect(proposals(input)).toEqual([])
    expect(buildWorkerLinkReport(input).merges).toEqual([])
  })

  it('proposes an ambiguous text candidate when the wire reader classifies rich text blank', async () => {
    const textCandidate = { cardId: a, fm_home: '/fixture/hulk', task_id: 'linked-worker', spawn_gen: 'attempt-1', sources: ['task.raw'], strength: 'textual-reference' as const }
    for (const rich_text of [[], [{ plain_text: ' \n\t' }]]) {
      const input = source()
      input.fleet[0]!.observation.data!.tasks[0]!.cardReferences = cardReferences({ raw: `card ${a}` }, 'task')
      const property = await readTasksProperty({ rich_text })
      expect(property.workerLinks).toEqual({ status: 'unknown', reason: BLANK_PROPERTY_REASON })
      expect(property.type).toBe('rich_text')
      expect(property.hasMore).toBe(false)
      expect(parseWorkerLinks(property.value)).toMatchObject({ status: 'invalid', reason: 'Malformed JSON' })
      input.intentions.data!.cards[0]!.properties['First Mate tasks'] = property
      const report = buildWorkerLinkReport(input)
      expect(report.coverage.cards).toContainEqual(expect.objectContaining({
        cardId: a, declaration: 'unknown', reason: BLANK_PROPERTY_REASON, mergeable: true,
      }))
      expect(report.homes[0]?.counts).toMatchObject({ ambiguous: 1, unavailable: 0 })
      expect(proposals(input)).toEqual([textCandidate])
      expect(report.merges[0]).toMatchObject({ cardId: a, status: 'ready-for-verification' })
    }
    const explicit = source()
    explicit.fleet[0]!.observation.data!.tasks[0]!.cardReferences = cardReferences({ raw: `card ${a}` }, 'task')
    const empty = JSON.stringify({ schema: WORKER_LINK_SCHEMA, tasks: [] })
    explicit.intentions.data!.cards[0]!.properties['First Mate tasks'] = await readTasksProperty({ rich_text: [{ plain_text: empty }] })
    const explicitReport = buildWorkerLinkReport(explicit)
    expect(explicitReport.coverage.cards).toContainEqual(expect.objectContaining({ cardId: a, declaration: 'valid', mergeable: true }))
    expect(proposals(explicit)).toEqual([textCandidate])
    for (const property of [
      { rich_text: [], has_more: true },
      { rich_text: [{}] },
      { type: 'select', select: { name: 'unset' } },
    ]) {
      const input = source()
      input.fleet[0]!.observation.data!.tasks[0]!.cardReferences = cardReferences({ raw: `card ${a}` }, 'task')
      const read = await readTasksProperty(property)
      expect(read.workerLinks).not.toEqual({ status: 'unknown', reason: BLANK_PROPERTY_REASON })
      input.intentions.data!.cards[0]!.properties['First Mate tasks'] = read
      const report = buildWorkerLinkReport(input)
      expect(report.coverage.cards.find(card => card.cardId === a)?.mergeable).toBe(false)
      expect(report.homes[0]?.counts.unavailable).toBe(1)
      expect(report.homes[0]?.counts.ambiguous).toBe(0)
      expect(proposals(input)).toEqual([])
    }
    const missing = source()
    missing.fleet[0]!.observation.data!.tasks[0]!.cardReferences = cardReferences({ raw: `card ${a}` }, 'task')
    delete missing.intentions.data!.cards[0]!.properties['First Mate tasks']
    const missingReport = buildWorkerLinkReport(missing)
    expect(missingReport.coverage.cards.find(card => card.cardId === a)?.mergeable).toBe(false)
    expect(missingReport.homes[0]?.counts.unavailable).toBe(1)
    expect(proposals(missing)).toEqual([])
  })
  it('accepts positive evidence with an unrelated truncated relation but never infers a missing generation', () => {
    const input = source()
    input.intentions.status = 'partial'; input.intentions.coverage = 'partial'
    input.intentions.data!.cards[0]!.properties['Parent item']!.hasMore = true
    expect(proposals(input)).toHaveLength(1)
    input.fleet[0]!.observation.data!.tasks[0]!.identity.spawn_gen = null
    expect(proposals(input)).toEqual([])
  })
  it.each(['Done', 'Archived'])('does not backfill historical %s cards', status => {
    const input = source()
    input.intentions.data!.cards[0]!.properties.Status!.value = status
    expect(proposals(input)).toEqual([])
  })
  it.each(['done [at=1]: complete', 'landed [at=1]: merged'])('excludes inactive workers from proposals and merges (%s)', event => {
    const input = source()
    input.fleet[0]!.observation.data!.tasks[0]!.lastEventText = event
    const report = buildWorkerLinkReport(input)
    expect(report.homes[0]!.counts).toEqual(Object.fromEntries(BACKFILL_TIERS.map(tier => [tier, 0])))
    expect(report.merges).toEqual([])
  })
  it('merges workers across homes with existing entries; five controlled pairs confirm after coordinator-style roundtrip', () => {
    const input = source(), home = input.fleet[0]!, task = home.observation.data!.tasks[0]!
    home.observation.data!.tasks = Array.from({ length: 4 }, (_, i) => ({ ...structuredClone(task), id: `worker-${i}`, identity: { ...task.identity, task_id: `worker-${i}` } }))
    const second = structuredClone(home)
    second.source.home = '/fixture/second'
    second.observation.data!.fm_home = second.source.home
    second.observation.data!.tasks = [{ ...structuredClone(task), identity: { ...task.identity, fm_home: second.source.home } }]
    input.fleet.push(second)
    const existing = link(input)
    declare(input, [existing])
    const before = JSON.stringify(input), report = buildWorkerLinkReport(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(report.homes.flatMap(h => h.tiers.ambiguous.flatMap(row => row.proposals))).toHaveLength(4)
    const merged = report.merges[0]!
    expect(merged.status).toBe('ready-for-verification')
    if (!merged.properties) throw new Error('Expected pasteable merge')
    const parsed = readWorkerLinks({ type: 'rich_text', ...merged.properties['First Mate tasks'] })
    expect(parsed.status).toBe('valid')
    if (parsed.status !== 'valid') throw new Error('Expected valid wire record')
    expect(parsed.tasks).toContainEqual(existing)
    expect(parsed.tasks).toHaveLength(5)
    input.intentions.data!.cards[0]!.properties['First Mate tasks']!.workerLinks = parsed
    expect(reconcileScene(input, now).claims.filter(c => c.verification === 'confirmed')).toHaveLength(5)
    expect(proposals(input)).toEqual([])
  })
  it('emits safe chunks and suppresses the entire pasteable merge at the size limit', () => {
    const input = source()
    declare(input, [{ ...link(input), task_id: 'old', first_observed_spawn_gen: 'x'.repeat(4000) }])
    const merge = buildWorkerLinkReport(input).merges[0]!
    expect(merge.properties?.['First Mate tasks'].rich_text.length).toBeGreaterThan(1)
    expect(readWorkerLinks({ type: 'rich_text', ...merge.properties?.['First Mate tasks'] }).status).toBe('valid')
    declare(input, [{ ...link(input), task_id: 'old', first_observed_spawn_gen: 'x' }])
    const property = input.intentions.data!.cards[0]!.properties['First Mate tasks']!
    const base = (property.value as string).length
    declare(input, [{ ...link(input), task_id: 'old', first_observed_spawn_gen: 'x'.repeat(MAX_WORKER_LINK_CHARS - base + 1) }])
    expect(buildWorkerLinkReport(input).merges).toEqual([{ cardId: a, status: 'size-limit', reason: expect.any(String) }])
  })
})

describe('deterministic detector report over Slice A classification', () => {
  it('tags duplicate primary declarations, spawn evidence, historical links and invalid records', () => {
    const input = source()
    declare(input, [link(input, { first_observed_spawn_gen: 'old-attempt' })])
    const other = structuredClone(input.intentions.data!.cards[0]!)
    other.id = b; other.properties.Status!.value = 'Done'
    input.intentions.data!.cards.push(other)
    const invalid = structuredClone(other)
    invalid.id = fixtureId(3); invalid.properties['First Mate tasks']!.value = '{'
    input.intentions.data!.cards.push(invalid)
    const report = buildWorkerLinkReport(input)
    expect(report.findings.map(f => f.detector)).toEqual(expect.arrayContaining(['duplicate-primary', 'spawn-evidence', 'historical-link', 'invalid-record']))
    for (const row of report.findings.filter(f => f.detector === 'duplicate-primary' || f.detector === 'spawn-evidence')) expect(row.classification).toBe('unverified-conflicting')
    const before = JSON.stringify(report)
    expect(JSON.stringify(buildWorkerLinkReport(structuredClone(input)))).toBe(before)
    input.intentions.data!.cards.reverse(); input.fleet.reverse()
    expect(JSON.stringify(buildWorkerLinkReport(input))).toBe(before)
  })
  it('reports absence only for a complete fresh home and current paginated Notion', () => {
    const input = source()
    declare(input, [link(input)])
    input.fleet[0]!.observation.data!.tasks = []
    expect(buildWorkerLinkReport(input).findings.some(f => f.detector === 'declared-absent')).toBe(true)
    for (const update of [() => { input.fleet[0]!.observation.status = 'stale' },
      () => { input.fleet[0]!.observation.status = 'fresh'; input.intentions.status = 'stale' },
      () => { input.intentions.status = 'partial'; input.intentions.data!.hasMore = true }]) {
      update()
      const report = buildWorkerLinkReport(input)
      expect(report.findings.some(f => f.detector === 'declared-absent')).toBe(false)
      expect(report.findings.some(f => f.detector === 'unknown-coverage')).toBe(true)
    }
  })
  it('ages sources at the saved evaluation timestamp and reports unconfigured homes as unknown', () => {
    const input = source()
    declare(input, [link(input, { fm_home: '/not-configured' })])
    input.generatedAt = new Date(now + 120_000).toISOString()
    const report = buildWorkerLinkReport(input)
    expect(proposals(input)).toEqual([])
    expect(report.coverage.intentions.status).toBe('stale')
    expect(report.findings.some(f => f.detector === 'declared-absent')).toBe(false)
    expect(report.findings.some(f => f.detector === 'unknown-coverage' && f.homeIds.includes('/not-configured'))).toBe(true)
  })
  it('retains positive contradictions with partial coverage, and unknown missing spawn evidence', () => {
    const input = source(), home = input.fleet[0]!, task = home.observation.data!.tasks[0]!
    declare(input, [link(input)])
    home.observation.status = 'partial'; home.observation.coverage = 'partial'
    home.observation.data!.tasks.push({ ...structuredClone(task), identity: { ...task.identity, spawn_gen: 'attempt-2' } })
    expect(buildWorkerLinkReport(input).findings.some(f => f.detector === 'spawn-evidence')).toBe(true)
    home.observation.data!.tasks = [{ ...task, identity: { ...task.identity, spawn_gen: null } }]
    const report = buildWorkerLinkReport(input)
    expect(report.findings.some(f => f.detector === 'spawn-evidence')).toBe(false)
    expect(report.findings.some(f => f.detector === 'unknown-coverage')).toBe(true)
  })
  it.each([true, false])('detects undeclared generations independently of references (%s)', referenced => {
    const input = source(), home = input.fleet[0]!, task = home.observation.data!.tasks[0]!
    if (!referenced) task.cardReferences = []
    home.observation.status = 'partial'; home.observation.coverage = 'partial'
    home.observation.data!.tasks.push({ ...structuredClone(task), identity: { ...task.identity, spawn_gen: 'attempt-2' } })
    input.intentions.status = 'stale'
    const scene = reconcileScene(input, now)
    expect(scene.findings.filter(f => f.workerLinkDetectors?.includes('spawn-evidence'))).toEqual([
      expect.objectContaining({ kind: 'unverified-conflicting', executionIds: expect.arrayContaining(scene.executions.map(e => e.id)) }),
    ])
    const report = buildWorkerLinkReport(input)
    expect(report.homes[0]!.counts.conflicts).toBe(2)
    expect(report.homes[0]!.counts.unavailable).toBe(0)
    expect(report.findings.some(f => f.detector === 'spawn-evidence')).toBe(true)
    expect(report.merges).toEqual([])
    home.observation.data!.tasks.reverse()
    expect(buildWorkerLinkReport(input)).toEqual(report)
    home.observation.status = 'stale'
    expect(buildWorkerLinkReport(input).findings.some(f => f.detector === 'spawn-evidence')).toBe(false)
    home.observation.status = 'partial'
    home.observation.data!.tasks[0]!.identity.spawn_gen = null
    expect(buildWorkerLinkReport(input).findings.some(f => f.detector === 'spawn-evidence')).toBe(false)
  })
  it('reports duplicate source identities without making duplicate proposals', () => {
    const input = source(), tasks = input.fleet[0]!.observation.data!.tasks
    tasks.push(structuredClone(tasks[0]!))
    const report = buildWorkerLinkReport(input)
    expect(report.findings.some(f => f.detector === 'duplicate-execution')).toBe(true)
    expect(report.homes.flatMap(h => h.tiers.ambiguous.flatMap(row => row.proposals))).toHaveLength(0)
    expect(report.merges).toEqual([])
  })
  it('retains the other Slice A classifications, including untracked workers and confirmed links', () => {
    const input = source()
    expect(buildWorkerLinkReport(input).findings.some(f => f.detector === 'untracked-worker')).toBe(true)
    declare(input, [link(input)])
    expect(buildWorkerLinkReport(input).findings.some(f => f.detector === 'confirmed-link')).toBe(true)
  })
})

describe('operational six-tier dry run', () => {
  it('keeps exact declaration matches, candidates, independent workers, contradictions and unavailable homes distinct', () => {
    const input = source(), home = input.fleet[0]!, original = home.observation.data!.tasks[0]!
    home.observation.data!.tasks = ['candidate', 'confirmed', 'independent', 'reused'].map(id => ({
      ...structuredClone(original), id, identity: { ...original.identity, task_id: id }, lastEventText: 'PRIVATE TASK PROSE',
    }))
    home.observation.data!.tasks[2]!.cardReferences = []
    declare(input, [link(input, { task_id: 'confirmed' }), link(input, { task_id: 'reused', first_observed_spawn_gen: 'old' })])
    const offline = structuredClone(home)
    offline.source.home = '/fixture/offline'
    offline.observation.status = 'stale'; offline.observation.coverage = 'unknown'
    offline.observation.data!.tasks = [{ ...structuredClone(original), identity: { ...original.identity, fm_home: offline.source.home } }]
    input.fleet.push(offline)
    const report = buildWorkerLinkReport(input), first = report.homes.find(h => h.fm_home === home.source.home)!
    expect(Object.keys(first.tiers)).toEqual([...BACKFILL_TIERS])
    expect(first.counts).toEqual({ 'already confirmed': 1, 'eligible auto-write': 0, ambiguous: 1, independent: 1, conflicts: 1, unavailable: 0 })
    expect(report.homes.find(h => h.fm_home === offline.source.home)?.counts.unavailable).toBe(1)
    expect(report.dispatchProvenance.status).toBe('not-collected')
    expect(JSON.stringify(report)).not.toContain('PRIVATE TASK PROSE')
  })
  it('never promotes legacy IDs, URLs, title equality or claimed dispatch field names to auto-write authority', () => {
    const input = source(), task = input.fleet[0]!.observation.data!.tasks[0]!
    task.cardReferences = [
      ...cardReferences({ notion_page_id: a, work_item: a, raw: `card ${a}`, title: `https://app.notion.com/p/${a}` }, 'task'),
      { pageId: a, basis: 'explicit', source: 'task.dispatch_provenance' },
    ]
    const report = buildWorkerLinkReport(input)
    expect(report.homes[0]?.tiers['eligible auto-write']).toEqual([])
    expect(report.homes[0]?.counts.ambiguous).toBe(1)
  })
  it('represents an offline home with no cached inventory as unknown coverage, not a zero-worker count', () => {
    const input = source()
    input.fleet[0]!.observation.status = 'unknown'; input.fleet[0]!.observation.coverage = 'unknown'; input.fleet[0]!.observation.data = null
    const report = buildWorkerLinkReport(input)
    expect(report.homes[0]?.tiers.unavailable).toEqual([expect.objectContaining({ kind: 'home', task_id: null, spawn_gen: null })])
    expect(report.homes[0]?.tiers.independent).toEqual([])
  })
})

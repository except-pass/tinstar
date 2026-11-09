import { afterEach, describe, expect, it } from 'vitest'
import { fixtureId, fixtureScene, fixtureSources } from '../../../test-fixtures/reconciliation/scenes'
import { SceneReconciler } from '../../server/reconciliation/scene'
import { SmartSearchIndex, directNeighbors, emptySearch, searchSeeds } from '../../shared/smartSearch'
import { boundSearchDocuments, sceneSearchDocuments, searchText, type SearchDocument } from '../../shared/searchDocuments'
import { workHealth } from '../../shared/workHealth'
import { statusProjection } from '../../shared/floorOrganization'
import { applyPresentationAction, initialPresentation } from '../presentation'
import { loadPresentationPreferences, savePresentationPreferences } from '../presentationPreferences'
import { actionSchema, stateSchema } from '../../shared/reconciliationCommands'

const now = Date.parse('2026-11-06T00:00:00Z')
const doc = (id: string, title: string, text = '', identifiers = [id]): SearchDocument => ({ key: `card:${id}`, target: { kind: 'card', id }, title, identifiers,
  fields: [{ name: 'Description', source: 'Notion blocks', text }], coverage: 'fresh/complete', observedAt: new Date(now).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() })
afterEach(() => localStorage.clear())

describe('deterministic Find', () => {
  it('cold-builds a bounded 150-card prose index within the interactive startup budget', () => {
    const sources = fixtureSources({ now, size: 143 })
    let remaining = 30
    for (const home of sources.fleet) {
      home.observation.data!.tasks = home.observation.data!.tasks.slice(0, remaining)
      remaining -= home.observation.data!.tasks.length
    }
    const scene = new SceneReconciler().reconcile(sources)
    const documents = boundSearchDocuments(sceneSearchDocuments(scene).map(document => ({ ...document,
      fields: [...document.fields, { name: 'Description', source: 'Notion blocks', text:
        (`Bounded fixture prose for ${document.title}. Plan the migration, check errors and publish evidence. `).repeat(120) }],
    }))).documents
    expect(scene.cards).toHaveLength(150)
    expect(scene.executions).toHaveLength(30)
    expect(documents.reduce((total, document) => total + document.fields.reduce((length, field) => length + field.text.length, 0), 0)).toBeGreaterThan(1_000_000)
    const index = new SmartSearchIndex(), started = performance.now()
    index.update(documents)
    // The expected build is ~125 ms; allow substantial CI variance while
    // rejecting the multi-second eager-offset regression.
    expect(performance.now() - started).toBeLessThan(450)
    expect(index.search('Roadmap', now).some(hit => hit.document.target.id === fixtureId(5))).toBe(true)
  }, 10_000)

  it('preserves original fuzzy ranges across Unicode expansion and incremental replacement', () => {
    const index = new SmartSearchIndex()
    index.update([doc('a', 'Other', '  PR #2920 then oﬃce coordinator')])
    const before = index.search('ofice')[0]!
    expect(before.field.name).toBe('Description')
    index.update([doc('a', 'Other', 'Changed oﬃce coordinator')])
    const after = index.search('ofice')[0]!
    expect(after.ranges.map(([a, b]) => after.field.text.slice(a, b + 1)).join(' ')).toBe('oﬃce')
    expect(before.ranges.map(([a, b]) => before.field.text.slice(a, b + 1)).join(' ')).toBe('oﬃce')
  })

  it.each([
    ['PR #2920', '2920', '2920'],
    ['  Release Coordinator', '"release coordinator"', 'Release Coordinator'],
    ['oﬃce release', 'office', 'oﬃce'],
    ['e\u0301 release', 'é', 'e\u0301'],
    ['😀 Release', 'release', 'Release'],
    ['  PR #2920', '"pr 2920"', 'PR #2920'],
  ])('maps literal ranges to original text %s', (text, query, expected) => {
    const index = new SmartSearchIndex()
    index.update([doc('a', 'Other', text)])
    const hit = index.search(query)[0]!
    expect(hit.field.name).toBe('Description')
    expect(hit.ranges.map(([a, b]) => hit.field.text.slice(a, b + 1)).join(' ')).toBe(expected)
  })

  it.each(['identifier', 'name', 'body'])('highlights accepted numeric tokens in %s fields', source => {
    const text = '  PR #12920; PR #2920'
    const index = new SmartSearchIndex()
    index.update([doc('a', source === 'name' ? text : 'Other', source === 'body' ? text : '', source === 'identifier' ? [text] : ['a'])])
    for (const query of ['2920', 'PR 2920']) {
      const hit = index.search(query)[0]!
      expect(hit.field.text).toBe(text)
      const numeric = hit.ranges.filter(([a, b]) => hit.field.text.slice(a, b + 1) === '2920')
      expect(numeric).toEqual([[text.lastIndexOf('2920'), text.length - 1]])
    }
    index.update([doc('a', 'Other', 'PR #12920; x2920; 2920x')])
    expect(index.search('2920')).toEqual([])
  })

  it.each(['identifier', 'name', 'body'])('matches and highlights exact quoted numeric phrases in %s fields', source => {
    const document = (text: string) => doc('a', source === 'name' ? text : 'Other', source === 'body' ? text : '', source === 'identifier' ? [text] : ['a'])
    const index = new SmartSearchIndex()
    for (const query of ['"PR #2920"', '"PR 2920"']) {
      for (const near of ['PR #29201', 'PR #2920x', 'xPR #29201']) {
        index.update([document(near)])
        expect(index.search(query)).toEqual([])
      }
      const text = '  PR #29201; PR #2920'
      index.update([document(text)])
      const hit = index.search(query)[0]!
      expect(hit.field.text).toBe(text)
      expect(hit.ranges).toEqual([[text.lastIndexOf('PR'), text.length - 1]])
      expect(hit.field.text.slice(hit.ranges[0]![0], hit.ranges[0]![1] + 1)).toBe('PR #2920')
    }
    index.update([document('  Release Coordinator ﬃx')])
    const phrase = index.search('"release coordinator ffix"')[0]!
    expect(phrase.field.text.slice(phrase.ranges[0]![0], phrase.ranges[0]![1] + 1)).toBe('Release Coordinator ﬃx')
  })

  it('supports typo-tolerant multi-token names, prefix, phrases and mixed-field text', () => {
    const index = new SmartSearchIndex()
    index.update([doc('a', 'Release Coordinator', 'NEM3: fix HaveNoPermission error'), doc('b', 'Release notes', 'Coordinator summary')])
    expect(index.search('releese coordnator')[0]?.document.target.id).toBe('a')
    expect(index.search('NEM')[0]?.document.target.id).toBe('a')
    expect(index.search('release HaveNoPermission')[0]?.document.target.id).toBe('a')
    const error = index.search('HaveNoPermission')[0]!
    expect(error.field).toMatchObject({ name: 'Description', source: 'Notion blocks' })
    expect(error.ranges.some(([a, b]) => error.field.text.slice(a, b + 1) === 'HaveNoPermission')).toBe(true)
    expect(index.search('"Release Coordinator"').map(hit => hit.document.target.id)).toEqual(['a'])
    expect(index.search('"releese coordnator"')).toEqual([])
  })
  it('ranks exact identifiers, exact names, prefix, text then fuzzy; numeric IDs never drift', () => {
    const index = new SmartSearchIndex()
    index.update([doc('id', 'Other title', '', ['PR #2920', '2920', '0143']), doc('name', 'PR #2920'), doc('prefix', 'PR #2920 release'), doc('text', 'Notes', 'Mention PR #2920'), doc('near', '0144 release PR #2921')])
    expect(index.search('PR #2920').map(hit => hit.document.target.id)).toEqual(['id', 'name', 'prefix', 'text'])
    expect(index.search('0143').map(hit => hit.document.target.id)).toEqual(['id'])
    expect(index.search('0142')).toEqual([])
    expect(index.search('#2920')[0]?.document.target.id).toBe('id')
  })
  it('upserts changes, removes inaccessible identities and rebuilds from available metadata', () => {
    const index = new SmartSearchIndex()
    index.update([doc('a', 'Original'), doc('b', 'Private')])
    index.update([doc('a', 'Updated')])
    expect(index.search('Original')).toEqual([])
    expect(index.search('Private')).toEqual([])
    expect(index.search('Updated')[0]?.document.target.id).toBe('a')
    const scene = fixtureScene({ now })
    index.update(sceneSearchDocuments(scene))
    expect(index.search('linked-worker')[0]?.document.target.kind).toBe('execution')
  })
  it('drops expired prose even on a retained scene and rebuilds it only from a refreshed authorized observation', () => {
    const index = new SmartSearchIndex(), document = doc('a', 'Release work', 'HaveNoPermission')
    document.expiresAt = new Date(now + 1000).toISOString()
    index.update([document])
    expect(index.search('HaveNoPermission', now)).toHaveLength(1)
    expect(index.search('HaveNoPermission', now + 1001)).toEqual([])
    expect(index.search('Release', now + 1001)).toHaveLength(1)
    index.update([{ ...document, expiresAt: new Date(now + 5000).toISOString() }])
    expect(index.search('HaveNoPermission', now + 1001)).toHaveLength(1)
  })
  it('retains shared fuzzy vocabulary for remaining records and refreshes match provenance on metadata-only updates', () => {
    const index = new SmartSearchIndex(), first = doc('a', 'Release Coordinator'), remaining = doc('b', 'Release notes')
    index.update([first, remaining])
    expect(index.search('releese')).toHaveLength(2)
    index.update([remaining])
    expect(index.search('releese').map(hit => hit.document.target.id)).toEqual(['b'])
    const refreshed = { ...remaining, observedAt: '2026-11-06T01:00:00Z', coverage: 'stale/unknown' }
    index.update([refreshed])
    expect(index.search('releese')[0]!.document).toMatchObject({ observedAt: refreshed.observedAt, coverage: refreshed.coverage })
    index.update([doc('b', 'Inventory')])
    expect(index.search('releese')).toEqual([])
  })
  it('redacts credential literals and bounds excerpts while retaining canonical identity', () => {
    const secret = 'ghp_12345678901234567890'
    expect(searchText(`failure ${secret} token=abcdefghijklmnop`)).toBe('failure [credential omitted] token=[credential omitted]')
    const result = boundSearchDocuments([doc('id', 'Title', `${secret} ${'x'.repeat(20_000)}`)])
    expect(result.documents[0]!.fields[0]!.text.length).toBeLessThanOrEqual(8192)
    expect(result.documents[0]!.fields[0]!.text).not.toContain(secret)
    expect(result.documents[0]!.identifiers).toEqual(['id'])
    expect(result.notes).not.toEqual([])
  })
})

describe('health and graph predicates', () => {
  it.each([
    { type: 'relation', value: ['  explicit  ', 'other'], matches: true },
    { type: 'select', value: '  explicit  ', matches: true },
    { type: 'rich_text', value: '  explicit  ', matches: true },
    { type: 'multi_select', value: ['explicit'], matches: false },
    { type: 'relation', value: [], matches: false },
  ])('uses explicit Initiative $type values without ancestry fallback', ({ type, value, matches }) => {
    const scene = fixtureScene({ now })
    for (const card of scene.cards) delete card.source.properties.Initiative
    const card = scene.cards.find(card => card.id === fixtureId(2))!
    card.ancestry = ['parent-only']
    card.source.properties.Initiative = { id: 'initiative', type, value, hasMore: false }
    const seeds = (initiative: string) => searchSeeds(scene, { ...emptySearch(), facets: [{ field: 'initiative', value: initiative }] }, now)
    expect(seeds('parent-only')).toEqual([])
    expect(seeds('explicit').some(seed => seed.id === card.id)).toBe(matches)
    delete card.source.properties.Initiative
    expect(searchSeeds({ ...scene }, { ...emptySearch(), facets: [{ field: 'initiative', value: 'parent-only' }] }, now)).toEqual([])
  })

  it.each([{ tags: ['Decision'] }, { tags: ['Merge'] }, { tags: ['Decision', 'Merge'] }, { tags: [] }])('classifies published Will action tags $tags', ({ tags }) => {
    const scene = fixtureScene({ now })
    const card = scene.cards.find(card => card.id === fixtureId(2))!
    card.source.properties['Will action'] = { id: 'will', type: 'multi_select', value: tags, hasMore: false }
    expect(workHealth(scene, card.id, now).patterns.decision.outcome).toBe(tags.length ? 'match' : 'no-match')
    expect(searchSeeds(scene, { ...emptySearch(), patterns: ['decision'] }, now).some(seed => seed.id === card.id)).toBe(tags.length > 0)
  })

  it('never calls one waiting plus one running worker stalled; unsupported evidence stays null', () => {
    const scene = fixtureScene({ now })
    const helper = scene.executions.find(worker => worker.identity.task_id === 'helper-worker')!
    helper.liveness = 'waiting'
    const health = workHealth(scene, fixtureId(1), now)
    expect(health).toMatchObject({ workerCount: 2, running: 1, waiting: 1, runnable: null, activeResolverCount: null, lastProgressAt: null })
    expect(health.patterns.active.outcome).toBe('match')
    expect(health.patterns.stalled.outcome).toBe('no-match')
    expect(health.patterns.stale.outcome).toBe('unavailable')
    for (const worker of scene.executions) worker.liveness = 'waiting'
    expect(workHealth(scene, fixtureId(1), now).patterns.stalled.outcome).toBe('unavailable')
  })
  it('coalesces verified blocked workers and retains tracked blocker evidence without resolver guesses', () => {
    const scene = fixtureScene({ now })
    const blocked = scene.executions.find(worker => worker.identity.task_id === 'blocked-worker')!
    blocked.source.backlog.blocked_by = 'HILDA-auth'
    const another = { ...blocked, id: 'other-blocked', identity: { ...blocked.identity, task_id: 'other-blocked' } }
    scene.executions.push(another)
    scene.claims.push({ ...scene.claims.find(link => link.executionId === blocked.id)!, id: 'other-link', executionId: another.id })
    const health = workHealth(scene, fixtureId(4), now)
    expect(health.patterns.blocked.outcome).toBe('match')
    expect(health.blockers).toEqual(['HILDA-auth'])
    expect(health.workerCount).toBe(2)
    const seeds = searchSeeds(scene, { ...emptySearch(), patterns: ['blocked'] }, now)
    expect(seeds).toEqual([{ kind: 'card', id: fixtureId(4) }])
    expect(directNeighbors(scene, seeds).size).toBe(3)
  })
  it('uses explicit human requests and suspends absence on partial/stale sources and failed reads', () => {
    const scene = fixtureScene({ now })
    const gap = workHealth(scene, fixtureId(2), now)
    expect(gap.patterns.unstaffed.outcome).toBe('match')
    expect(workHealth(scene, fixtureId(3), now).patterns.unstaffed.outcome).toBe('unavailable')
    scene.cards[1]!.source.properties['Will action'] = { id: 'will', type: 'rich_text', value: 'Choose API shape', hasMore: false }
    expect(workHealth(scene, scene.cards[1]!.id, now).patterns.decision.outcome).toBe('match')
    scene.coverage.homes[1]!.observation.coverage = 'partial'
    expect(workHealth(scene, fixtureId(2), now).patterns.unstaffed.outcome).toBe('unavailable')
    expect(workHealth(scene, fixtureId(1), now + 61_000).patterns.active.outcome).toBe('unavailable')
    expect(workHealth(scene, fixtureId(2), now, true).patterns.unstaffed.outcome).toBe('unavailable')
  })
  it('composes text, pattern and machine on the same verified pair, with one-hop deduplicated context', () => {
    const scene = fixtureScene({ now })
    const search = { ...emptySearch(), query: 'reconciliation', patterns: ['active' as const], facets: [{ field: 'machine' as const, value: 'Hulk' }] }
    expect(searchSeeds(scene, search, now)).toEqual([{ kind: 'card', id: fixtureId(1) }])
    expect(searchSeeds(scene, { ...search, facets: [{ field: 'machine', value: 'Mac' }] }, now)).toEqual([])
    const initial = scene.claims.find(link => link.cardId === fixtureId(1))!
    scene.claims.push({ ...initial, id: 'other-task', cardId: fixtureId(6) })
    const expanded = directNeighbors(scene, [{ kind: 'card', id: fixtureId(1) }])
    expect(expanded.size).toBe(3)
    expect(expanded.has(`card:${fixtureId(6)}`)).toBe(false)
    scene.claims.push({ ...initial, id: 'unverified', cardId: fixtureId(3), verification: 'unverified' })
    expect(directNeighbors(scene, [{ kind: 'card', id: fixtureId(3) }]).size).toBe(1)
  })
  it('composes donuts and search and reveals outside-scope endpoints only by explicit result selection', () => {
    const scene = fixtureScene({ now })
    const base = { ...initialPresentation(), search: { ...emptySearch(), query: 'Roadmap' }, donutFilter: { cards: ['Waiting For'], workers: [] } }
    expect(statusProjection(scene, base, now).cards).toEqual([])
    const selected = applyPresentationAction(base, { type: 'reveal-search', target: { kind: 'card', id: fixtureId(5) } }, scene, now).state
    expect(statusProjection(scene, selected, now).cards.map(card => card.id)).toEqual([fixtureId(5)])
    expect(selected.statusFilter).toEqual(base.statusFilter)
    expect(selected.donutFilter).toEqual(base.donutFilter)
    const cleared = applyPresentationAction(selected, { type: 'clear-search' }, scene, now).state
    expect(statusProjection(scene, cleared, now).cards.map(card => card.id)).toEqual([fixtureId(4)])
  })
  it('persists inspected search conditions through the shared schema, excluding transient reveal', () => {
    const scene = fixtureScene({ now }), search = { ...emptySearch(), query: 'release', patterns: ['active' as const] }
    const action = actionSchema.parse({ type: 'set-search', search })
    const state = applyPresentationAction(initialPresentation(), action, scene, now).state
    expect(stateSchema.safeParse(state).success).toBe(true)
    savePresentationPreferences({ ...state, searchReveal: { kind: 'card', id: fixtureId(5) } })
    expect(loadPresentationPreferences().search).toEqual(search)
    expect(loadPresentationPreferences().searchReveal).toBeUndefined()
    expect(actionSchema.safeParse({ type: 'set-search', search: { ...search, sql: 'arbitrary' } }).success).toBe(false)
  })
})


describe('pattern evidence dependencies', () => {
  it.each(['stalled', 'blocked', 'decision', 'unstaffed', 'mismatch', 'stale', 'active'] as const)('%s retains cards with unavailable evidence and an explanation', pattern => {
    const scene = fixtureScene({ now })
    scene.coverage.intentions.status = 'stale'
    const card = scene.cards.find(card => card.id === fixtureId(1))!
    const result = workHealth(scene, card.id, now).patterns[pattern]
    expect(result.outcome).toBe('unavailable')
    expect(result.reason.length).toBeGreaterThan(0)
    expect(searchSeeds(scene, { ...emptySearch(), patterns: [pattern] }, now)).toContainEqual({ kind: 'card', id: card.id })
  })
  it.each(['stale', 'liveness-not-observed', 'no worker'] as const)('Waiting For plus non-empty text is blocked with %s', condition => {
    const scene = fixtureScene({ now })
    const worker = scene.executions.find(worker => worker.identity.task_id === 'blocked-worker')!
    if (condition === 'stale') worker.observation.status = 'stale'
    if (condition === 'liveness-not-observed') worker.liveness = 'liveness-not-observed'
    if (condition === 'no worker') { scene.executions = scene.executions.filter(entry => entry.id !== worker.id); scene.claims = scene.claims.filter(claim => claim.executionId !== worker.id) }
    expect(workHealth(scene, fixtureId(4), now).patterns.blocked.outcome).toBe('match')
    scene.cards.find(card => card.id === fixtureId(4))!.source.properties['Waiting For']!.value = '  '
    expect(workHealth(scene, fixtureId(4), now).patterns.blocked.outcome).toBe('no-match')
  })
  it('gives the stale worker age when current execution evidence cannot decide a pattern', () => {
    const scene = fixtureScene({ now })
    for (const worker of scene.executions) {
      worker.observation.status = 'stale'
      worker.source.last_event.age_seconds = 3 * 86400
    }
    const result = workHealth(scene, fixtureId(1), now).patterns.active
    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('last reported 3d ago')
  })
  it('does not turn unread worker decision requests into a negative result', () => {
    const scene = fixtureScene({ now })
    const worker = scene.executions.find(worker => worker.identity.task_id === 'blocked-worker')!
    worker.observation.status = 'stale'
    expect(workHealth(scene, fixtureId(4), now).patterns.decision.outcome).toBe('unavailable')
  })
  it('keeps the card visibly secondary when a text-qualified pattern matches its worker', () => {
    const scene = fixtureScene({ now })
    const worker = scene.executions.find(worker => worker.identity.task_id === 'blocked-worker')!
    const search = { ...emptySearch(), query: worker.identity.task_id!, patterns: ['blocked' as const] }
    const seeds = searchSeeds(scene, search, now)
    expect(seeds).toEqual([{ kind: 'execution', id: worker.id }])
    expect(directNeighbors(scene, seeds)).toContain(`card:${fixtureId(4)}`)
    expect(statusProjection(scene, { ...initialPresentation(), search }, now).cards.map(card => card.id)).toEqual([fixtureId(4)])
  })
})


it.each(['Done', 'Archived'] as const)('%s never enters Blocked or Stalled, even with old source evidence and waiting workers', status => {
  const scene = fixtureScene({ now })
  const card = scene.cards.find(card => card.id === fixtureId(4))!
  card.source.properties.Status!.value = status
  scene.coverage.intentions.status = 'stale'
  for (const pattern of ['blocked', 'stalled'] as const) {
    expect(workHealth(scene, card.id, now).patterns[pattern].outcome).toBe('no-match')
    expect(searchSeeds(scene, { ...emptySearch(), patterns: [pattern] }, now)).not.toContainEqual({ kind: 'card', id: card.id })
  }
})

it('retains a terminal worker as secondary context for a matching work card', () => {
  const scene = fixtureScene({ now })
  const worker = scene.executions.find(worker => worker.identity.task_id === 'blocked-worker')!
  worker.liveness = 'finished'
  const search = { ...emptySearch(), patterns: ['blocked' as const] }
  expect(statusProjection(scene, { ...initialPresentation(), search }, now).workers.map(worker => worker.id)).toContain(worker.id)
})


it('rechecks unknown membership when a worker observation expires before the home/source observations', () => {
  const scene = fixtureScene({ now })
  for (const worker of scene.executions) worker.observation = { ...worker.observation, expiresAt: new Date(now + 5000).toISOString() }
  const search = { ...emptySearch(), patterns: ['stalled' as const] }
  const card = { kind: 'card', id: fixtureId(1) }
  expect(searchSeeds(scene, search, now)).not.toContainEqual(card)
  expect(searchSeeds(scene, search, now + 6000)).toContainEqual(card)
})

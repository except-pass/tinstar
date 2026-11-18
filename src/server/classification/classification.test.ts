import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CardLeases } from '../reconciliation/cardLeases'
import { notionCard } from '../reconciliation/notion'
import { NotionApi } from '../reconciliation/notionApi'
import { ClassificationCatalog, type Catalog } from './catalog'
import { assess, classifyCard, thresholds } from './classify'
import { jevModel, OpenRouterJev, type DecisionRequest, type JevResponse } from './openRouter'
import { dryRunReport } from './report'
import { ClassificationService } from './service'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const id = (n: number) => n.toString(16).padStart(32, '0')
const prop = (name: string | null) => ({ type: 'select', select: name ? { name } : null })
function card(n: number, title: string, initiative: string | null, epic: string | null, status = 'In Progress', parent?: number) {
  return {
    object: 'page', id: id(n), last_edited_time: '2026-11-17T00:00:00.000Z',
    properties: {
      Name: { type: 'title', title: [{ plain_text: title }] },
      Status: prop(status), Owner: prop('Firstmate'), Area: prop('Platform'),
      Initiative: prop(initiative), Epic: prop(epic),
      'Parent item': { type: 'relation', relation: parent ? [{ id: id(parent) }] : [] },
    },
  }
}

const examples = [card(1, 'Rotate service sessions', 'Platform', 'Operations'),
  card(2, 'Update panel status', 'Cockpit', 'Operations'), card(3, 'Retired work', 'Retired', 'Old epic', 'Done')]
const options = (names: string[]) => ({ id: 'test', type: 'select', options: names,
  relation: null })
const schema = { Name: options([]), Owner: options([]), Status: options([]),
  Initiative: options(['Platform', 'Cockpit', 'Retired']), Epic: options(['Operations', 'Old epic']) }
const board = {
  status: 'fresh' as const, coverage: 'complete' as const, observedAt: null, expiresAt: null, attemptedAt: '', error: null,
  data: { dataSourceId: id(99), schema, cards: examples.map(item => notionCard(item)), hasMore: false,
    scope: '', truncatedRelations: [], missingSchemaProperties: [] },
}

function modelDecision(request: DecisionRequest, initiativeId: string, pairId: string,
  overrides: Record<string, number> = {}): JevResponse {
  const answers = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
    if (question.type === 'noul') return [key, { type: 'noul', noul: overrides[key] ?? (key === 'ambiguous' ? 0.02 : 0.99) }]
    const selected = key === 'initiative' ? initiativeId : pairId
    return [key, { type: 'choice', choice: selected, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(question.criteria).map(id => [id, Number(id === selected)])) }]
  })) as JevResponse['answers']
  return { model: `${jevModel}-20261014`, answers, usage: { input_tokens: 800, output_tokens: 100, cost: 0.00001 },
    latencyMs: 222, attempts: 1 }
}

function candidates(catalog: Catalog, initiative: string, epic: string | null = 'Operations') {
  return [catalog.initiatives.find(row => row.initiative === initiative)!.id,
    catalog.pairs.find(row => row.initiative === initiative && row.epic === epic)!.id] as const
}

describe('classifier catalog and policy', () => {
  const cache = new ClassificationCatalog({ initiatives: [{ initiative: 'Platform', initiativeOnly: true }] })
  const catalog = cache.get(board)
  const source = {
    parent: async (value: string) => board.data.cards.find(card => card.id === value),
    excerpt: async () => ({ outcome: 'available' as const, blocks: [{ id: 'brief', type: 'paragraph',
      text: 'Close the gap in session rotation. api_key=privateabcdefghijkl A reference https://test.invalid/?pwd=private' }] }),
  }

  it('keeps select options, disambiguates same-name epics and excludes retired destinations', async () => {
    expect(catalog.initiativeOptions).toContain('Retired')
    expect(catalog.pairs.filter(pair => pair.epic === 'Operations')).toHaveLength(2)
    expect(catalog.initiatives.map(row => row.initiative)).not.toContain('Retired')
    const ask = vi.fn(async (request: DecisionRequest) => modelDecision(request, ...candidates(catalog, 'Platform')))
    const result = await classifyCard(notionCard(card(4, 'Rotation', 'Platform', null)), catalog, source, ask)
    expect(assess(result, thresholds.conservative)).toEqual({
      outcome: 'candidate', destination: { initiative: 'Platform', epic: 'Operations' },
    })
    const request = ask.mock.calls[0]![0]
    expect(JSON.stringify(request)).not.toMatch(/privateabcdefghijkl|test\.invalid|Rotate service sessions.+Update panel status/)
    expect(Object.keys(request.questions.destination!.criteria)).toContain('none')
    expect(cache.get(board)).toBe(catalog)
    cache.invalidate()
    expect(cache.get(board)).not.toBe(catalog)
    expect(() => cache.get({ ...board, status: 'stale' })).toThrow(/fresh, complete/)
  })

  it('abstains for parent conflict, novelty and missing body, and skips an existing pair', async () => {
    const ask = vi.fn(async (request: DecisionRequest) => modelDecision(request, ...candidates(catalog, 'Platform')))
    const result = await classifyCard(notionCard(card(4, 'Rotation', null, null, 'In Progress', 2)), catalog, source, ask)
    expect(assess(result, thresholds.conservative)).toMatchObject({ reason: 'parent-conflict' })
    const novel = await classifyCard(notionCard(card(4, 'Novel work', null, null)), catalog, source,
      async request => modelDecision(request, ...candidates(catalog, 'Platform'), { [`epic_fit_${candidates(catalog, 'Platform')[0]}`]: 0.02 }))
    expect(assess(novel, thresholds.conservative)).toMatchObject({ reason: 'epic-no-fit' })
    const incomplete = await classifyCard(notionCard(card(4, 'Rotation', null, null)), catalog, {
      ...source, excerpt: async () => ({ outcome: 'unavailable', blocks: [] }),
    }, ask)
    expect(assess(incomplete, thresholds.conservative)).toMatchObject({ reason: 'incomplete-source' })
    const done = await classifyCard(notionCard(card(4, 'Rotation', 'Platform', 'Operations')), catalog, source, ask)
    expect(done.state).toBe('skipped')
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('does not use fit under a different initiative to accept the chosen pair', async () => {
    const ask = vi.fn(async (request: DecisionRequest) => {
      const scores = Object.fromEntries(Object.entries(request.questions)
        .filter(([, question]) => question.type === 'noul' && question.criteria.true.includes(' / Operations'))
        .map(([key, question]) => [key, question.criteria.true.includes('Cockpit / Operations') ? 0.99 : 0.02]))
      return modelDecision(request, ...candidates(catalog, 'Platform'), scores)
    })
    const result = await classifyCard(notionCard(card(4, 'Panel updates', null, null)), catalog, source, ask)
    expect(result).toMatchObject({ evidence: { epicFit: 0.02 } })
    expect(assess(result, thresholds.conservative)).toMatchObject({ reason: 'epic-no-fit' })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('redacts complete quoted passwords from model titles, body and catalog examples', async () => {
    const example = notionCard(card(1, `Example password='example secret fragments' confirmed`, 'Platform', 'Operations'))
    const privateCatalog = cache.get({ ...board, data: { ...board.data, cards: [example, ...board.data.cards.slice(1)] } })
    const ask = vi.fn(async (request: DecisionRequest) => modelDecision(request, ...candidates(privateCatalog, 'Platform')))
    const result = await classifyCard(notionCard(card(4, 'Rotation password="title secret fragments" confirmed', null, null)),
      privateCatalog, {
        ...source, excerpt: async () => ({ outcome: 'available', blocks: [{ id: 'brief', type: 'paragraph',
          text: String.raw`Rotate password="body \"quoted\" secret fragments" today
Initiative: password="another
multiline fragment"` }] }),
      }, ask)
    expect(assess(result, thresholds.conservative)).toMatchObject({ outcome: 'candidate' })
    const request = ask.mock.calls[0]![0]
    expect(request.state).toMatchObject({ card: {
      title: 'Rotation [credential omitted] confirmed', brief: 'Rotate [credential omitted] today',
    } })
    const [, pair] = candidates(privateCatalog, 'Platform')
    expect(request.questions.destination?.criteria[pair]).toContain('Example [credential omitted] confirmed')
    expect(JSON.stringify(request)).not.toMatch(/secret fragments|quoted|multiline fragment/)
  })

  it('supports an explicitly allowed initiative-only destination', async () => {
    const result = await classifyCard(notionCard(card(4, 'Initiative charter', null, null)), catalog, source,
      async request => modelDecision(request, ...candidates(catalog, 'Platform', null), { [`epic_fit_${candidates(catalog, 'Platform')[0]}`]: 0.01 }))
    expect(assess(result, thresholds.strict)).toEqual({
      outcome: 'candidate', destination: { initiative: 'Platform', epic: null },
    })
  })

  it('uses parent evidence without letting it override ambiguous, conflicting choices', async () => {
    const [initiative, pair] = candidates(catalog, 'Platform')
    const child = notionCard(card(4, 'Rotation', null, null, 'In Progress', 1))
    const agrees = await classifyCard(child, catalog, source, async request => modelDecision(request, initiative, pair))
    expect(assess(agrees, thresholds.conservative)).toMatchObject({ outcome: 'candidate' })
    const ambiguous = await classifyCard(child, catalog, source,
      async request => modelDecision(request, initiative, pair, { ambiguous: 0.62 }))
    expect(assess(ambiguous, thresholds.conservative)).toMatchObject({ reason: 'ambiguous' })
    const newInitiative = await classifyCard(child, catalog, source,
      async request => modelDecision(request, 'none', 'none', { initiative_fit: 0.06 }))
    expect(assess(newInitiative, thresholds.conservative)).toMatchObject({ reason: 'initiative-no-fit' })
  })
})

describe('OpenRouter Decisions transport', () => {
  const request: DecisionRequest = { state: { title: 'One card' }, questions: {
    initiative: { type: 'choice', instructions: 'Choose', criteria: { a: 'Existing', none: 'No match' } },
    initiative_fit: { type: 'noul', instructions: 'Fit?', criteria: { true: 'Fits', false: 'No fit' } },
  } }
  const key = 'test-credential-not-for-output'
  it('uses the pinned endpoint, retries 429 and validates the served answer types', async () => {
    const send = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(Response.json(modelDecision(request, 'a', 'none')))
      .mockResolvedValueOnce(Response.json({ model: jevModel, answers: {} }))
    const ask = await new OpenRouterJev(send, async () => key).open()
    expect(await ask(request)).toMatchObject({ attempts: 2, answers: { initiative_fit: { type: 'noul', noul: 0.99 } } })
    expect(send.mock.calls[0]![0]).toBe('https://openrouter.ai/api/alpha/decisions')
    const init = send.mock.calls[0]![1]!
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${key}` })
    expect(JSON.parse(String(init.body))).toEqual({ model: jevModel, ...request })
    await expect(ask(request)).rejects.toMatchObject({ code: 'provider-shape' })
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('handles missing credentials, long cooldowns and timeouts', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '60' } }))
    await expect(new OpenRouterJev(send, async () => null).open()).rejects.toMatchObject({ code: 'credential-unavailable' })
    const ask = await new OpenRouterJev(send, async () => key).open()
    await expect(ask(request)).rejects.toMatchObject({ code: 'rate-limited' })
    await expect(ask(request)).rejects.toMatchObject({ code: 'rate-limited' })
    expect(send).toHaveBeenCalledTimes(1)
    const timeout = vi.fn<typeof fetch>(async (_input, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const timed = await new OpenRouterJev(timeout, async () => key, 5, async () => undefined).open()
    await expect(timed(request)).rejects.toMatchObject({ code: 'provider-timeout' })
    expect(timeout).toHaveBeenCalledTimes(3)
  })
})

it('reads the configured board through NotionApi and persists replay results in the shared database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jev-classifier-test-'))
  roots.push(root)
  const unassigned = card(4, 'Panel updates', null, null)
  const historical = card(5, 'Prior panel update', 'Cockpit', 'Operations', 'Done')
  const notion = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/query')) {
      const filter = JSON.parse(String(init?.body)).filter.and[0]
      return Response.json({ results: filter.or ? [historical, examples[2]] : [...examples.slice(0, 2), unassigned], has_more: false })
    }
    if (url.pathname.endsWith('/children')) return Response.json({ has_more: true, next_cursor: 'ignored', results: [{
      id: 'opening', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'Work on panel status support' }] },
    }] })
    return Response.json({ object: 'data_source', properties: Object.fromEntries(Object.entries(schema).map(([name, value]) =>
      [name, { type: value.type, id: value.id, select: { options: value.options.map(name => ({ name })) } }])) })
  })
  const model = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as DecisionRequest
    expect(JSON.stringify(request.state)).not.toContain('Prior panel update / Operations')
    expect(request.state).toMatchObject({ existing_classification: { initiative: '', epic: '' } })
    return Response.json(modelDecision(request, 'initiative_1', 'pair_1'))
  })
  const api = new NotionApi(notion, 0)
  const service = new ClassificationService({ token: 'test-notion-token', dataSourceId: id(99) },
    api, new CardLeases(root), new OpenRouterJev(model, async () => 'test-openrouter-credential'))
  for (const invalid of [0, -1, 1.5, 2001]) expect(() => service.dryRun(invalid)).toThrow(RangeError)
  expect(notion).not.toHaveBeenCalled()
  expect(model).not.toHaveBeenCalled()
  const running = service.dryRun(2000)
  expect(() => service.dryRun(0)).toThrow(RangeError)
  expect(service.dryRun(2000)).toBe(running)
  const report = await running
  expect(model).toHaveBeenCalledTimes(3)
  expect(notion.mock.calls.every(([url, init]) =>
    !init?.method || init.method === 'GET' || (init.method === 'POST' && String(url).endsWith('/query')))).toBe(true)
  expect(api.diagnostics.requests['GET blocks']).toBe(3)
  const rows = new CardLeases(root).readStorage(db => db.prepare('SELECT state, result, write_receipt FROM classification_jobs').all())
  expect(rows).toHaveLength(3)
  expect(rows.every(row => row.state === 'examined' && row.write_receipt === null)).toBe(true)
  expect(JSON.stringify(rows)).not.toMatch(/test-notion-token|test-openrouter-credential|Work on panel status support/)
  expect(dryRunReport(report, api.diagnostics)).toContain('Historical confusion matrix')
})

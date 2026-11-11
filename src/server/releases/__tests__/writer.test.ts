import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { buildQueue } from '../../reconciliation/queue'
import { needsWill } from '../../reconciliation/needsWill'
import { decisionItems } from '../../../shared/reconciliationQueue'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { releaseAssociations } from '../../../shared/releases'
import { filterReleases, releaseState } from '../../../releases/model'
import { planReleaseAutomation } from '../automation'
import { reconcileReleases } from '../reconcile'
import type { EvidenceRead } from '../evidence'
import { ReleaseAutomationWriter, type ReleaseTransport } from '../writer'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'release-writer-')); roots.push(root)
  await mkdir(join(root, 'releases'))
  const settings = join(root, 'releases', 'automation.json')
  await writeFile(settings, JSON.stringify({ version: 1, enabled }))
  const scene = fixtureScene(); scene.cards = scene.cards.slice(0, 2)
  const url = 'https://github.com/owner/repo/pull/1'
  for (const [index, card] of scene.cards.entries()) {
    card.source.properties.Status!.value = 'Waiting for Prod Release'
    card.source.properties.Owner!.value = 'Ada'
    card.source.properties.Link = { id: 'link', type: 'url', value: url, hasMore: false }
    card.source.properties['Requires production verification'] = { id: 'verify', type: 'checkbox', value: index === 0, hasMore: false }
  }
  const evidence: EvidenceRead = { status: 'fresh', warnings: [], collectedAt: new Date().toISOString(), repositories: new Map([['owner/repo', 'github']]), requirements: new Map([['owner/repo#1', { targets: [{ component: 'api', target: 'api-prod' }], exceptions: [] }]]), receipts: [{ id: 'prod-run', repository: 'owner/repo', environment: 'production', component: 'api', target: 'api-prod', deployedSha: 'b'.repeat(40), artifactDigest: null, version: 'v1', deployedAt: new Date().toISOString(), workflowUrl: 'https://github.com/owner/repo/actions/runs/1', receiptUrl: 'https://example.com/receipt', outcome: 'succeeded', exceptions: [] }] }
  const read = vi.fn(async () => {
    const data = releaseAssociations(scene)
    for (const pull of data.pulls) Object.assign(pull, { state: 'merged', freshness: 'fresh', mergeSha: 'a'.repeat(40) })
    const reconciled = await reconcileReleases(data, scene, evidence, async () => ({ state: 'ancestor' }), await writer().receipts())
    reconciled.automation = planReleaseAutomation(reconciled, scene, { requestedEnabled: enabled, configuration: 'configured', warnings: [] })
    return reconciled
  })
  const notes = new Map<string, string[]>(), calls: string[] = []
  const transport: ReleaseTransport = {
    card: vi.fn(async id => scene.cards.find(card => card.id === id)!.source),
    hasNote: vi.fn(async (id, marker) => notes.get(id)?.includes(marker) ?? false),
    note: vi.fn(async (id, _text, marker) => { if (!notes.get(id)?.includes(marker)) { notes.set(id, [...(notes.get(id) ?? []), marker]); calls.push(`comment:${id}`) } }),
    transition: vi.fn(async (card, proposal) => { calls.push(`status:${card.id}:${proposal.to}`); card.properties.Status!.value = proposal.to }),
  }
  const writer = () => new ReleaseAutomationWriter(root, transport, read)
  return { root, scene, evidence, read, transport, calls, notes, writer, settings }
}

describe('default-OFF production writer and shared Desk publication', () => {
  it('does nothing while OFF, including after a prior enabled pass', async () => {
    const f = await setup(false), writer = f.writer()
    const before = await readdir(join(f.root, 'releases'))
    expect(await writer.run()).toEqual({ enabled: false, completed: [] })
    expect(f.read).not.toHaveBeenCalled(); expect(f.transport.card).not.toHaveBeenCalled()
    expect(await readdir(join(f.root, 'releases'))).toEqual(before)
  })
  it('closes the unflagged neighbor and routes only the opted-in card, then replays without side effects or status flapping', async () => {
    const f = await setup(), writer = f.writer()
    await writer.run()
    expect(f.scene.cards.map(card => card.source.properties.Status!.value)).toEqual(['In Progress', 'Done'])
    const queue = await writer.desk()
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({ title: expect.stringContaining('Ada:'), readiness: 'ready-now', oneTouch: false, cardIds: [f.scene.cards[0]!.id] })
    const desk = { ...buildQueue(fixtureSources()), items: queue }
    const unverified = needsWill(desk, f.scene, new Map(), null, new Map())
    expect(decisionItems({ ...desk, needsWill: unverified })).toEqual([])
    const contexts = new Map(f.scene.cards.map(card => [card.id, { outcome: 'available' as const, blocks: [] }]))
    const published = needsWill(desk, f.scene, contexts, null, new Map())
    expect(decisionItems({ ...desk, needsWill: published }).map(item => item.id)).toEqual([queue[0]!.id])
    expect(queue[0]!.evidence.some(link => link.url === f.evidence.receipts[0]!.workflowUrl)).toBe(true)
    const calls = [...f.calls]
    await f.writer().run(); expect(f.calls).toEqual(calls)
    f.scene.cards[1]!.source.properties.Status!.value = 'Waiting for Prod Release'
    await f.writer().run(); expect(f.calls).toEqual(calls)
    // Opening Desk is not verification. Only the explicit existing card workflow
    // can finish the check; observing Done removes its actionable queue entry.
    expect(f.scene.cards[0]!.source.properties.Status!.value).toBe('In Progress')
    f.scene.cards[0]!.source.properties.Status!.value = 'Done'
    expect(await writer.desk()).toEqual([])
    f.scene.cards[0]!.source.properties.Status!.value = 'In Progress'
    expect(await f.writer().desk()).toEqual([])
  })
  it('completes ownerless unchecked work and retains post-transition projections', async () => {
    const f = await setup()
    f.scene.cards[1]!.source.properties.Owner!.value = ''
    await f.writer().run()
    expect(f.scene.cards.map(card => card.source.properties.Status!.value)).toEqual(['In Progress', 'Done'])
    const data = await f.read()
    expect(data.pulls).toHaveLength(1)
    expect(data.pulls[0]!.links.filter(link => link.active)).toHaveLength(2)
    expect(data.pulls[0]!.deployment).toMatchObject({ state: 'shipped', verificationRequired: true })
    expect(data.automation!.proposals).toEqual([])
    f.scene.cards[0]!.source.properties.Status!.value = 'Done'
    expect((await f.read()).pulls[0]!.deployment).toMatchObject({ state: 'shipped', verificationRequired: false })
  })
  it('retires resolved routes during reconciliation and publishes only a later release', async () => {
    const f = await setup(), writer = f.writer()
    f.scene.cards[0]!.source.properties.Status!.value = 'In Progress'
    expect(filterReleases((await f.read()).pulls, 'Verify in Prod')).toEqual([])
    f.scene.cards[0]!.source.properties.Status!.value = 'Waiting for Prod Release'
    expect(filterReleases((await f.read()).pulls, 'Verify in Prod')).toHaveLength(1)
    await writer.run()
    expect(filterReleases((await f.read()).pulls, 'Verify in Prod')).toHaveLength(1)
    f.scene.cards[0]!.source.properties.Status!.value = 'Done'
    await writer.run()
    f.scene.cards[0]!.source.properties.Status!.value = 'In Progress'
    expect(await f.writer().desk()).toEqual([])
    const reopened = await f.read()
    expect(filterReleases(reopened.pulls, 'Verify in Prod')).toEqual([])
    expect(filterReleases(reopened.pulls, 'Shipped')).toHaveLength(1)
    expect(releaseState(reopened.pulls[0]!)).toBe('Shipped')
    expect(reopened.automation!.proposals).toEqual([])
    f.scene.cards[0]!.source.properties.Status!.value = 'Waiting for Prod Release'
    f.evidence.receipts[0]!.id = 'next-prod-run'
    await writer.run()
    const queue = await f.writer().desk()
    expect(queue).toHaveLength(1)
    expect(filterReleases((await f.read()).pulls, 'Verify in Prod')).toHaveLength(1)
    await writer.run()
    expect(await writer.desk()).toHaveLength(1)
    const routes = (await writer.receipts()).filter(row => row.proposal.desk)
    expect(routes).toHaveLength(2)
    expect(queue[0]!.id).toBe(routes[1]!.proposal.desk!.item.id)
  })
  it('reads current cards after a Desk request waits behind a routing writer', async () => {
    const f = await setup(), writer = f.writer()
    let release!: () => void, entered!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const transition = f.transport.transition
    f.transport.transition = vi.fn(async (card, proposal) => {
      if (proposal.desk) { entered(); await paused }
      await transition(card, proposal)
    })
    const running = writer.run()
    await started
    const captured = structuredClone(f.scene.cards.map(card => card.source))
    expect(captured[0]!.properties.Status!.value).toBe('Waiting for Prod Release')
    const desk = writer.desk()
    release()
    await running
    expect(await desk).toHaveLength(1)
    expect((await writer.receipts()).find(row => row.proposal.desk)?.verificationResolvedAt).toBeUndefined()
    expect(filterReleases((await f.read()).pulls, 'Verify in Prod')).toHaveLength(1)
    const read = f.read.getMockImplementation()!
    const stale = structuredClone(await read())
    stale.reconciliation!.cards[0]!.status = 'Waiting for Prod Release'
    f.read.mockResolvedValueOnce(stale)
    await writer.run()
    expect(await writer.desk()).toHaveLength(1)
    f.scene.cards[0]!.source.properties.Status!.value = 'Done'
    expect(await writer.desk()).toEqual([])
    f.scene.cards[0]!.source.properties.Status!.value = 'In Progress'
    expect(await writer.desk()).toEqual([])
    expect(filterReleases((await f.read()).pulls, 'Verify in Prod')).toEqual([])
    f.scene.cards[0]!.source.properties.Status!.value = 'Waiting for Prod Release'
    f.evidence.receipts[0]!.id = 'next-prod-run'
    await writer.run()
    expect(await writer.desk()).toHaveLength(1)
    await writer.run()
    expect(await writer.desk()).toHaveLength(1)
  })
  it('waits for both required PRs and evaluates one shared PR/card edge independently', async () => {
    const f = await setup()
    f.scene.cards[1]!.source.properties['GitHub PRs'] = { id: 'prs', type: 'rich_text', hasMore: false, value: 'https://github.com/owner/repo/pull/2' }
    await f.writer().run()
    expect(f.scene.cards.map(card => card.source.properties.Status!.value)).toEqual(['In Progress', 'Waiting for Prod Release'])
    f.evidence.requirements.set('owner/repo#2', { targets: [{ component: 'api', target: 'api-prod' }], exceptions: [] })
    await f.writer().run()
    expect(f.scene.cards[1]!.source.properties.Status!.value).toBe('Done')
  })
  it('repairs a lost status response after restart without duplicate comments or PATCH', async () => {
    const f = await setup(), original = f.transport.transition
    f.transport.transition = vi.fn(async (card, proposal) => { await original(card, proposal); throw new Error('Response lost after save') })
    await f.writer().run()
    expect((await f.writer().receipts()).every(row => row.phase === 'pending')).toBe(true)
    const calls = [...f.calls]
    await f.writer().run()
    expect((await f.writer().receipts()).every(row => row.phase === 'done')).toBe(true)
    expect(f.calls).toEqual(calls)
  })
  it.each(['snapshot', 'stale', 'rollback', 'flag', 'wrong-repo', 'skipped', 'partial', 'missing-link'])('holds %s evidence without any comment/status write', async variant => {
    const f = await setup()
    if (variant === 'snapshot' || variant === 'stale') f.evidence.status = variant
    if (variant === 'rollback' || variant === 'skipped' || variant === 'partial') f.evidence.receipts[0]!.outcome = variant
    if (variant === 'flag') f.evidence.receipts[0]!.exceptions.push('Known disabled flag')
    if (variant === 'wrong-repo') f.evidence.receipts[0]!.repository = 'other/repo'
    if (variant === 'missing-link') f.scene.cards.forEach(card => { delete card.source.properties.Link })
    await f.writer().run()
    expect(f.calls).toEqual([])
  })
  it('requires the checkbox schema and rechecks an opt-in change immediately before PATCH', async () => {
    const f = await setup()
    delete f.scene.cards[1]!.source.properties['Requires production verification']
    const note = f.transport.note
    f.transport.note = async (id, text, marker) => { await note(id, text, marker); f.scene.cards[0]!.source.properties['Requires production verification']!.value = false }
    await f.writer().run()
    expect(f.calls.filter(call => call.startsWith('status:'))).toEqual([])
    expect(f.scene.cards.every(card => card.source.properties.Status!.value === 'Waiting for Prod Release')).toBe(true)
  })
  it('supports audited skip/resume of a stuck operation without bypassing current safety checks', async () => {
    const f = await setup(); f.transport.transition = vi.fn(async () => { throw new Error('Notion unavailable') })
    const writer = f.writer(); await writer.run()
    const id = (await writer.receipts())[0]!.proposal.id
    await expect(writer.disposition(id, 'skip', 'owner', '')).rejects.toThrow('reason')
    await writer.disposition(id, 'skip', 'owner', 'Inspect this card before retrying')
    expect((await f.writer().receipts()).find(row => row.proposal.id === id)).toMatchObject({ phase: 'skipped', disposition: { actor: 'owner', reason: 'Inspect this card before retrying' } })
    await writer.disposition(id, 'resume', 'owner', 'Source corrected; resume normal checks')
    f.evidence.status = 'stale'
    const calls = [...f.calls]; await writer.run(); expect(f.calls).toEqual(calls)
  })
})

it('uses the shared paced Notion content transport with deduplicated evidence comments and a status-only PATCH', async () => {
  const { WorkReader } = await import('../../reconciliation/workReader')
  const { NotionApi } = await import('../../reconciliation/notionApi')
  const { notionReleaseTransport } = await import('../writer')
  const f = await setup(), id = f.scene.cards[1]!.id, dataSourceId = 'f'.repeat(32), comments: unknown[] = [], requests: Array<{ method: string; body: any }> = []
  const raw = { object: 'page', id, last_edited_time: new Date().toISOString(), parent: { data_source_id: dataSourceId }, properties: {
    Status: { type: 'status', status: { name: 'Waiting for Prod Release' } }, Owner: { type: 'select', select: { name: 'Ada' } },
    'Requires production verification': { type: 'checkbox', checkbox: false }, 'Next action': { type: 'rich_text', rich_text: [{ text: { content: 'Existing unrelated ask' } }] },
  } }
  const api = new NotionApi(async (input, init) => {
    const method = init?.method ?? 'GET', url = String(input), body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ method, body })
    if (url.includes('/comments')) {
      if (method === 'POST') comments.push({ id: 'comment', rich_text: body.rich_text })
      return new Response(JSON.stringify({ results: comments, has_more: false }), { status: 200 })
    }
    if (method === 'PATCH') raw.properties.Status.status.name = body.properties.Status.status.name
    return new Response(JSON.stringify(raw), { status: 200 })
  }, 0)
  const transport = notionReleaseTransport(new WorkReader({ dataSourceId, token: 'fixture' }, api))
  const proposal = (await f.read()).automation!.proposals.find(row => row.cardId === id)!
  await transport.note(id, proposal.auditText, 'receipt-marker')
  await transport.note(id, proposal.auditText, 'receipt-marker')
  expect(comments).toHaveLength(1)
  await transport.transition(await transport.card(id), proposal)
  expect(requests.filter(request => request.method === 'PATCH').map(request => request.body)).toEqual([{ properties: { Status: { status: { name: 'Done' } } } }])
  expect(raw.properties['Next action'].rich_text[0]!.text.content).toBe('Existing unrelated ask')
})

it('offers an audited recovery from corrupt local receipts while OFF without reading or writing the board', async () => {
  const { readFile } = await import('node:fs/promises')
  const f = await setup(false), writer = f.writer()
  const file = join(f.root, 'releases', 'writer-receipts.json')
  await writeFile(file, '{corrupt')
  await expect(writer.receipts()).rejects.toThrow()
  const result = await writer.recoverReceipts('owner', 'Restore receipt storage after inspecting the affected cards')
  expect(await readFile(result.backup, 'utf8')).toBe('{corrupt')
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ records: [], recovery: { actor: 'owner', reason: result.reason, backup: result.backup } })
  expect(f.read).not.toHaveBeenCalled(); expect(f.calls).toEqual([])
})

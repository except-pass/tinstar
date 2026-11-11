import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ReconciliationMcp, type PresentationReaders } from '../mcp'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkflowOperations } from '../workflow'
import { WorkReader } from '../workReader'
import { NotionApi } from '../notionApi'
import { buildQueue } from '../queue'
import { reviewView } from '../reviews'
import { notionCard } from '../notion'
import { fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { reviewIdentity, type ReviewEvidence } from '../../../shared/reviews'
import { ReviewDeploymentAudit, ReviewDeploymentReconciler, type FloorDeployment } from '../reviewDeployment'
import { AssociationStore } from '../../releases/associations'
import { reconcileScene } from '../scene'
import { recordLateEvidence } from '../../../../scripts/deploy/review-handoff.mjs'

const id = 'a'.repeat(32), board = 'b'.repeat(32), sha = 'c'.repeat(40), head = 'd'.repeat(40)
const pr = 'https://github.com/except-pass/tinstar/pull/999'
const review: ReviewEvidence = { submission_key: 'review-one', deliverable_id: 'review-panel', summary: 'Delivered review panel', pulls: [{ url: pr, head }],
  deployment_id: `floor:${sha}`, deployed_sha: sha, live_url: 'https://example.test/?review=1', instructions: 'Open the panel and inspect both cards',
  proof: { kind: 'ui', tested_sha: sha, passed: true, receipt: 'https://example.test/evidence/test', screenshots: ['https://example.test/evidence/screen.png'] }, remaining_scope: [] }
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'review-workflow-')); directories.push(root)
  const raw = { object: 'page', id, parent: { data_source_id: board }, last_edited_time: new Date().toISOString(), archived: false, in_trash: false,
    properties: { Name: { type: 'title', title: [{ plain_text: 'Delivered UI' }] }, Status: { type: 'status', status: { name: 'In Progress' } },
      Owner: { type: 'select', select: { name: 'Firstmate' } }, Area: { type: 'select', select: { name: 'Tin Star' } },
      'Last touched by': { type: 'rich_text', rich_text: [] }, 'Waiting For': { type: 'rich_text', rich_text: [] },
      'Sub-item': { type: 'relation', relation: [] }, Link: { type: 'url', url: pr } } as Record<string, any> }
  const comments: any[] = [], patches: any[] = []
  const children: Record<string, typeof raw> = {}
  let rejectPatch = false
  let patchLoss = false, noteLoss = false, rejectNote = false, readFailure = false
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : null
    if (readFailure) return new Response('{}', { status: 429 })
    const child = children[path.split('/').at(-1)!]
    if (child) return Response.json(child)
    if (path.endsWith(`/pages/${id}`)) {
      if (method === 'PATCH' && rejectPatch) { rejectPatch = false; return new Response('{}', { status: 429 }) }
      if (method === 'PATCH') { patches.push(body); for (const [field, value] of Object.entries(body.properties)) Object.assign(raw.properties[field], value); if (patchLoss) { patchLoss = false; throw new Error('Response lost after applying PATCH') } }
      return Response.json(raw)
    }
    if (path.endsWith('/comments')) {
      if (method === 'POST') {
        if (rejectNote) { rejectNote = false; return new Response('{}', { status: 429 }) }
        comments.push({ id: `note-${comments.length}`, rich_text: body.rich_text })
        if (noteLoss) { noteLoss = false; throw new Error('Response lost after applying comment') }
      }
      return Response.json({ results: comments, has_more: false })
    }
    throw new Error(`Unexpected request ${method} ${path}`)
  }) as typeof fetch
  const restart = () => {
    const reader = new WorkReader({ dataSourceId: board, token: 'fixture' }, new NotionApi(fetcher, 0))
    const operations = new WorkflowOperations(reader, async () => [], root)
    operations.validateReview = vi.fn(async () => {})
    return operations
  }
  return { root, raw, comments, patches, restart, children, rejectPatch: () => { rejectPatch = true }, failPatch: () => { patchLoss = true }, failNote: () => { noteLoss = true }, rejectNote: () => { rejectNote = true }, failRead: () => { readFailure = true } }
}
const submit = (operation_id = 'submit-one') => ({ kind: 'submit_for_review' as const, card_id: id, operation_id, review })

describe('canonical review projection', () => {
  it('includes both owners exactly once without routing them as decisions', () => {
    const source = fixtureSources(), card = source.intentions.data!.cards[0]!
    card.properties.Status!.value = 'Ready for Review'; card.properties.Owner!.value = 'Firstmate'
    card.properties['Will action'] = { id: 'action', type: 'multi_select', value: [], hasMore: false }
    card.properties['Waiting For'] = { id: 'wait', type: 'rich_text', value: '', hasMore: false }
    source.intentions.data!.cards = [card, card, { ...card, id: 'b'.repeat(32), properties: { ...card.properties, Owner: { ...card.properties.Owner!, value: 'Will' } } }]
    const queue = buildQueue(source, undefined, Date.parse(source.generatedAt))
    expect(queue.reviews.items.map(row => row.cardId)).toEqual([card.id, 'b'.repeat(32)].sort())
    expect(queue.items.filter(row => row.cardIds.length)).toEqual([])
  })
  it('keeps known review rows but never claims empty coverage on stale/partial sources', () => {
    const source = fixtureSources().intentions
    source.data!.cards = []; source.status = 'stale'
    expect(reviewView(source)).toMatchObject({ complete: false, items: [], warning: expect.any(String) })
    source.status = 'fresh'; source.coverage = 'partial'
    expect(reviewView(source).complete).toBe(false)
  })
})

describe('durable shared review operations', () => {
  it('couples Owner/Status, confirms evidence and suppresses retries/new keys after restart', async () => {
    const f = await fixture()
    expect(await f.restart().update(submit(), 'Firstmate')).toMatchObject({ outcome: 'saved', saved_fields: expect.arrayContaining(['Owner', 'Status', 'note']) })
    expect(f.patches[0].properties).toMatchObject({ Owner: { select: { name: 'Will' } }, Status: { status: { name: 'Ready for Review' } } })
    f.raw.properties.Status.status.name = 'In review'
    const retry = { ...submit('new-operation'), review: { ...review, submission_key: 'new-key' } }
    expect(await f.restart().update(retry, 'Firstmate')).toMatchObject({ outcome: 'saved', code: 'already-submitted' })
    expect(f.comments).toHaveLength(1); expect(f.patches).toHaveLength(1)
    expect(f.raw.properties.Status.status.name).toBe('In review')
  })
  it('reconciles successful ambiguous PATCH without replaying properties after restart', async () => {
    const f = await fixture(); f.failPatch()
    expect(await f.restart().update(submit(), 'Firstmate')).toMatchObject({ outcome: 'partially-saved' })
    expect(await f.restart().update(submit(), 'Firstmate')).toMatchObject({ outcome: 'saved' })
    expect(f.patches).toHaveLength(1); expect(f.comments).toHaveLength(1)
  })
  it('reconciles a lost successful note response and preserves feedback on redeploy', async () => {
    const f = await fixture(); f.failNote()
    expect(await f.restart().update(submit(), 'Firstmate')).toMatchObject({ outcome: 'partially-saved' })
    expect(await f.restart().update(submit(), 'Firstmate')).toMatchObject({ outcome: 'saved' })
    expect(f.comments).toHaveLength(1)
    expect(await f.restart().update({ kind: 'request_review_changes', operation_id: 'feedback', card_id: id, submission_key: review.submission_key, feedback: 'Touch targets need work', remaining_scope: ['Touch targets'], scope_complete: false }, 'Tin Star UI')).toMatchObject({ outcome: 'saved' })
    expect(f.raw.properties.Owner.select.name).toBe('Firstmate'); expect(f.raw.properties.Status.status.name).toBe('Queued')
    await f.restart().update(submit(), 'Firstmate')
    expect(f.raw.properties.Status.status.name).toBe('Queued'); expect(f.comments).toHaveLength(2)
  })
  it('repairs a definitely rejected comment after property save, across restart', async () => {
    const f = await fixture(); f.rejectNote()
    expect(await f.restart().update(submit(), 'Firstmate')).toMatchObject({ outcome: 'partially-saved' })
    expect(await f.restart().update(submit(), 'Firstmate')).toMatchObject({ outcome: 'saved' })
    expect(f.patches).toHaveLength(1); expect(f.comments).toHaveLength(1)
  })
  it('does not write when the source returns 429', async () => {
    const f = await fixture(); f.failRead()
    expect(await f.restart().update(submit(), 'Firstmate')).toMatchObject({ outcome: 'not-saved' })
    expect(f.patches).toHaveLength(0)
  })
  it('records explicit acceptance and completes only attested full scope without dependencies', async () => {
    const f = await fixture(); await f.restart().update(submit(), 'Firstmate')
    const accept = { kind: 'accept_review' as const, operation_id: 'accept', card_id: id, submission_key: review.submission_key, feedback: 'Will inspected and accepts', remaining_scope: [], scope_complete: true }
    expect(await f.restart().update(accept, 'Tin Star UI')).toMatchObject({ outcome: 'saved' })
    expect(f.raw.properties.Status.status.name).toBe('Done')
    expect(JSON.stringify(f.comments)).toContain('accepted_by')
    expect(await f.restart().update(accept, 'Tin Star UI')).toMatchObject({ code: 'already-saved' })
    expect(f.comments).toHaveLength(2)
  })
  it('keeps an accepted parent open when provisioning remains', async () => {
    const f = await fixture(); await f.restart().update(submit(), 'Firstmate')
    f.raw.properties['Waiting For'].rich_text = [{ text: { content: 'GitHub App provisioning' } }]
    expect(await f.restart().update({ kind: 'accept_review', operation_id: 'accept', card_id: id, submission_key: review.submission_key, feedback: 'UI accepted', remaining_scope: [], scope_complete: true }, 'Tin Star UI')).toMatchObject({ outcome: 'saved' })
    expect(f.raw.properties.Status.status.name).toBe('Queued')
    expect(f.raw.properties['Waiting For'].rich_text[0].text.content).toBe('GitHub App provisioning')
  })
})

describe('deployment audit reconciliation', () => {
  it.each(['historical', 'late-first', 'normal-first'])('repairs %s evidence once, preserving receipt and smoke across restart', async order => {
    const f = await fixture(), audit = new ReviewDeploymentAudit(f.root), associations = new AssociationStore(f.root)
    const source = fixtureSources(); source.fleet = []; source.intentions.data!.cards = [notionCard(f.raw)]
    const scene = () => ({ ...reconcileScene({ ...source, intentions: { ...source.intentions, data: { ...source.intentions.data!, cards: [notionCard(f.raw)] } } }), claimHistory: [], historyScope: 'current' })
    const deployment: FloorDeployment = { action: 'floor-deployment', id: review.deployment_id, time: new Date().toISOString(), oldSha: 'e'.repeat(40), newSha: sha,
      membershipComplete: true, pulls: [{ url: pr, head, mergeSha: sha }], ownerHome: null, evidence: [], nonReviewable: [], warnings: [] }
    const newer = { ...deployment, id: `floor:${head}`, oldSha: sha, newSha: head, pulls: [] }
    const receipts = [{ ...deployment, pulls: [], membershipComplete: false, warnings: ['Discovery failed'] }, deployment, { action: 'floor-smoke', deploymentId: deployment.id, newSha: sha, time: new Date().toISOString(), passed: true, receipt: 'Historical guarded smoke' }, newer]
    await writeFile(audit.path, receipts.map(row => JSON.stringify(row)).join('\n') + '\n')
    const workflow = f.restart(); workflow.validateReview = input => audit.validate(input, scene(), associations)
    const update = vi.fn(workflow.update.bind(workflow)), deliver = vi.fn(async () => ({ saved: true }))
    const reconcile = () => new ReviewDeploymentReconciler(new ReviewDeploymentAudit(f.root), { scene: async () => scene(), associations, update, deliver }).run(true)
    await reconcile()
    const prior = (await audit.exceptions()).find(row => row.deploymentId === deployment.id)!
    expect(prior.missing).toContain('Configured Firstmate home responsible for handoff delivery')
    expect(update).not.toHaveBeenCalled()
    await writeFile(join(f.root, 'config.json'), JSON.stringify({ firstmate: { homes: ['/fixture'] } }))
    const manifest = join(f.root, 'evidence.json')
    await writeFile(manifest, JSON.stringify({ evidence: [{ card_id: id, review }] }))
    const env = { TINSTAR_CONFIG_HOME: f.root, TINSTAR_REVIEW_EVIDENCE_FILE: manifest }
    const normal = { ...deployment, ownerHome: '/fixture', evidence: [{ card_id: id, review }] }
    if (order === 'normal-first') {
      await writeFile(audit.path, (await readFile(audit.path, 'utf8')) + JSON.stringify({ ...normal, evidence: [] }) + '\n')
      await recordLateEvidence(deployment.id, env)
    } else {
      if (order === 'late-first') await writeFile(manifest, JSON.stringify({ evidence: [] }))
      await recordLateEvidence(deployment.id, env)
      if (order === 'late-first') {
        await writeFile(audit.path, (await readFile(audit.path, 'utf8')) + JSON.stringify(normal) + '\n')
        await writeFile(manifest, JSON.stringify({ evidence: [{ card_id: id, review }] }))
      }
    }
    await reconcile()
    expect((await audit.exceptions()).some(row => row.id === prior.id)).toBe(false)
    expect(update).toHaveBeenCalledTimes(1)
    expect(f.raw.properties.Status.status.name).toBe('Ready for Review')
    expect(f.comments).toHaveLength(1)
    const completed = await readFile(audit.path, 'utf8')
    await recordLateEvidence(deployment.id, env)
    await reconcile()
    expect(await readFile(audit.path, 'utf8')).toBe(completed)
    expect(update).toHaveBeenCalledTimes(1)
    expect((await audit.read()).filter(row => row.action === 'floor-deployment' || row.action === 'floor-smoke')).toEqual(order === 'historical' ? receipts : [...receipts, order === 'normal-first' ? { ...normal, evidence: [] } : normal])
  })

  it('validates actual receipt, PR/head and canonical association and retains missing proof across restart', async () => {
    const f = await fixture(), audit = new ReviewDeploymentAudit(f.root), store = new AssociationStore(f.root)
    const source = fixtureSources(); source.intentions.data!.cards = [notionCard(f.raw)]
    const scene = { ...reconcileScene(source, Date.parse(source.generatedAt)), claimHistory: [], historyScope: 'current' }
    const deployment: FloorDeployment = { action: 'floor-deployment', id: review.deployment_id, time: new Date().toISOString(), oldSha: 'e'.repeat(40), newSha: sha,
      membershipComplete: true, pulls: [{ url: pr, head, mergeSha: sha }], ownerHome: '/fixture', evidence: [], nonReviewable: [], warnings: [] }
    await writeFile(audit.path, JSON.stringify(deployment) + '\n')
    await expect(audit.validate(submit(), scene, store)).rejects.toMatchObject({ code: 'smoke-missing' })
    const deliver = vi.fn(async () => ({ saved: true })), update = vi.fn(async () => ({ outcome: 'saved' as const, code: 'ok', message: 'saved', operation_id: 'x', saved_fields: [] }))
    await new ReviewDeploymentReconciler(audit, { scene: async () => scene, associations: store, deliver, update }).run(true)
    const exceptions = await new ReviewDeploymentAudit(f.root).exceptions()
    expect(exceptions.length).toBeGreaterThan(0)
    expect(exceptions[0]!.missing.join(' ')).toContain('smoke')
    await new ReviewDeploymentReconciler(audit, { scene: async () => scene, associations: store, deliver, update }).run(true)
    expect(deliver).toHaveBeenCalledTimes(1); expect(update).not.toHaveBeenCalled()
    expect(reviewIdentity(id, review)).toContain(sha)
  })
})

it('serves the same bounded operation through UI and MCP, with identical durable identity', async () => {
  const f = await fixture(), workflow = f.restart()
  const readers = { updateWork: workflow.update.bind(workflow) } as PresentationReaders
  const mcp = new ReconciliationMcp(readers, f.root)
  const server = createServer((req, res) => { void mcp.handle(req, res) })
  const client = new Client({ name: 'review-parity', version: '1' })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`
    seedOriginAllowlist(port)
    const token = (await readFile(join(f.root, 'mcp-token'), 'utf8')).trim()
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/api/reconciliation/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const result = await client.callTool({ name: 'update_work', arguments: submit() })
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ outcome: 'saved' })
    const response = await fetch(`${base}/api/reconciliation/workflow`, { method: 'POST', headers: { 'X-Tinstar-UI': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'update', input: submit() }) })
    expect((await response.json()).data).toMatchObject({ outcome: 'saved', code: 'already-submitted' })
    expect(f.comments).toHaveLength(1)
  } finally { await client.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); resetOriginAllowlistForTests() }
})

it('automatically submits a green explicitly associated deployment once through the real writer', async () => {
  const f = await fixture(), audit = new ReviewDeploymentAudit(f.root), associations = new AssociationStore(f.root)
  const source = fixtureSources(); source.fleet = []; source.intentions.data!.cards = [notionCard(f.raw)]
  const scene = () => ({ ...reconcileScene({ ...source, intentions: { ...source.intentions, data: { ...source.intentions.data!, cards: [notionCard(f.raw)] } } }), claimHistory: [], historyScope: 'current' })
  const deployment: FloorDeployment = { action: 'floor-deployment', id: review.deployment_id, time: new Date().toISOString(), oldSha: 'e'.repeat(40), newSha: sha,
    membershipComplete: true, pulls: [{ url: pr, head, mergeSha: sha }], ownerHome: '/fixture', evidence: [{ card_id: id, review }], nonReviewable: [], warnings: [] }
  await writeFile(audit.path, [deployment, { action: 'floor-smoke', deploymentId: review.deployment_id, newSha: sha, time: new Date().toISOString(), passed: true, receipt: 'Fixture guarded smoke' }].map(row => JSON.stringify(row)).join('\n') + '\n')
  const workflow = f.restart(); workflow.validateReview = input => audit.validate(input, scene(), associations)
  const deliver = vi.fn(async () => ({ saved: true }))
  await new ReviewDeploymentReconciler(audit, { scene: async () => scene(), associations, update: workflow.update.bind(workflow), deliver }).run(true)
  expect(await audit.exceptions()).toEqual([])
  expect(f.raw.properties.Status.status.name).toBe('Ready for Review')
  expect(f.comments).toHaveLength(1)
  await new ReviewDeploymentReconciler(new ReviewDeploymentAudit(f.root), { scene: async () => scene(), associations, update: f.restart().update.bind(f.restart()), deliver }).run(true)
  expect(f.comments).toHaveLength(1); expect(deliver).not.toHaveBeenCalled()
  await workflow.update({ kind: 'accept_review', operation_id: 'accept', card_id: id, submission_key: review.submission_key, feedback: 'Accepted', remaining_scope: [], scope_complete: true }, 'Tin Star UI')
  const completed = await audit.read()
  source.intentions.data!.cards = []
  const absent = { ...reconcileScene(source), claimHistory: [], historyScope: 'current' }
  const update = vi.fn(workflow.update.bind(workflow))
  await new ReviewDeploymentReconciler(new ReviewDeploymentAudit(f.root), { scene: async () => absent, associations, update, deliver }).run(true)
  expect(await audit.read()).toEqual(completed)
  expect(await audit.exceptions()).toEqual([])
  expect(update).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled()
})

it('keeps a failed live UI proof or absent screenshot as a specific durable exception', async () => {
  const f = await fixture(), audit = new ReviewDeploymentAudit(f.root), associations = new AssociationStore(f.root)
  const source = fixtureSources(); source.fleet = []; source.intentions.data!.cards = [notionCard(f.raw)]
  const scene = { ...reconcileScene(source), claimHistory: [], historyScope: 'current' }
  const deployment: FloorDeployment = { action: 'floor-deployment', id: review.deployment_id, time: new Date().toISOString(), oldSha: 'e'.repeat(40), newSha: sha,
    membershipComplete: true, pulls: [{ url: pr, head, mergeSha: sha }], ownerHome: '/fixture', evidence: [{ card_id: id, review: { ...review, proof: { ...review.proof, passed: false, screenshots: [] } } }], nonReviewable: [], warnings: [] }
  await writeFile(audit.path, JSON.stringify(deployment) + '\n')
  await new ReviewDeploymentReconciler(audit, { scene: async () => scene, associations, update: f.restart().update.bind(f.restart()), deliver: async () => ({ saved: true }) }).run(true)
  expect((await audit.exceptions())[0]?.missing.join(' ')).toContain('proof.passed')
  expect((await audit.exceptions())[0]?.missing.join(' ')).toContain('proof.screenshots')
  expect(f.comments).toHaveLength(0)
})


it.each(['deployment', 'sha', 'proof', 'head', 'extra-pull'])('rejects stale %s evidence before an idempotent deployment success', async field => {
  const f = await fixture(), audit = new ReviewDeploymentAudit(f.root), associations = new AssociationStore(f.root)
  await f.restart().update(submit(), 'Firstmate')
  const evidence = structuredClone(review)
  if (field === 'deployment') evidence.deployment_id = 'floor:previous'
  if (field === 'sha') evidence.deployed_sha = 'e'.repeat(40)
  if (field === 'proof') evidence.proof.tested_sha = 'e'.repeat(40)
  if (field === 'head') evidence.pulls[0]!.head = 'e'.repeat(40)
  if (field === 'extra-pull') evidence.pulls.push({ url: pr.replace('999', '998'), head })
  const source = fixtureSources(); source.fleet = []; source.intentions.data!.cards = [notionCard(f.raw)]
  const scene = { ...reconcileScene(source), claimHistory: [], historyScope: 'current' }
  const deployment: FloorDeployment = { action: 'floor-deployment', id: review.deployment_id, time: new Date().toISOString(), oldSha: 'e'.repeat(40), newSha: sha,
    membershipComplete: true, pulls: [{ url: pr, head, mergeSha: sha }], ownerHome: '/fixture', evidence: [{ card_id: id, review: evidence }], nonReviewable: [], warnings: [] }
  await writeFile(audit.path, [deployment, { action: 'floor-smoke', deploymentId: review.deployment_id, newSha: sha, time: new Date().toISOString(), passed: true, receipt: 'Fixture smoke' }].map(row => JSON.stringify(row)).join('\n') + '\n')
  const workflow = f.restart(); workflow.validateReview = input => audit.validate(input, scene, associations)
  const update = vi.fn(workflow.update.bind(workflow))
  await new ReviewDeploymentReconciler(audit, { scene: async () => scene, associations, update, deliver: async () => ({ saved: true }) }).run(true)
  expect(update).not.toHaveBeenCalled()
  expect(await audit.exceptions()).toHaveLength(1)
  expect((await workflow.update({ ...submit(), review: evidence }, 'Firstmate')).outcome).toBe('not-saved')
  expect(f.comments).toHaveLength(1); expect(f.patches).toHaveLength(1)
})

it.each(['reopened', 'added', 'partial', 'waiting', 'remaining', 'complete'])('reconciles %s child scope before recovering acceptance', async scenario => {
  const f = await fixture(); await f.restart().update(submit(), 'Firstmate')
  const childId = 'f'.repeat(32)
  f.children[childId] = structuredClone(f.raw)
  f.children[childId]!.id = childId
  f.children[childId]!.properties.Status.status.name = 'Done'
  f.raw.properties['Sub-item'].relation = [{ id: childId }]
  const accept = { kind: 'accept_review' as const, operation_id: 'accept', card_id: id, submission_key: review.submission_key,
    feedback: 'UI accepted', remaining_scope: scenario === 'remaining' ? ['Provisioning'] : [], scope_complete: true }
  f.rejectPatch()
  expect(await f.restart().update(accept, 'Tin Star UI')).toMatchObject({ outcome: 'partially-saved' })
  if (scenario === 'reopened') f.children[childId]!.properties.Status.status.name = 'In Progress'
  if (scenario === 'added') {
    const addedId = 'e'.repeat(32)
    f.children[addedId] = structuredClone(f.children[childId]!)
    f.children[addedId]!.id = addedId
    f.children[addedId]!.properties.Status.status.name = 'Queued'
    f.raw.properties['Sub-item'].relation.push({ id: addedId })
  }
  if (scenario === 'waiting') f.raw.properties['Waiting For'].rich_text = [{ text: { content: 'Provisioning' } }]
  if (scenario === 'partial') f.raw.properties['Sub-item'].has_more = true
  const results = await f.restart().reconcileReviews()
  expect(results[0]?.result.outcome).toBe('saved')
  const status = scenario === 'complete' ? 'Done' : 'Queued'
  expect(f.raw.properties.Status.status.name).toBe(status)
  expect(f.comments).toHaveLength(2)
  const text = f.comments[1].rich_text.map((part: { text: { content: string } }) => part.text.content).join('')
  expect(text).toContain(`"next_status":"${status}"`)
  expect(text).toContain(JSON.stringify(accept.remaining_scope))
})

import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureScene, fixtureSources } from '../../../../test-fixtures/reconciliation/scenes'
import { decisionItems } from '../../../shared/reconciliationQueue'
import { releaseAssociations } from '../../../shared/releases'
import type { DeploymentReceipt } from '../../../shared/releaseReconciliation'
import { buildQueue } from '../../reconciliation/queue'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'
import { planReleaseAutomation, readAutomationSettings } from '../automation'
import { type EvidenceRead } from '../evidence'
import { reconcileReleases, ReleaseReconciler } from '../reconcile'
import { ReleasesApi } from '../routes'
import { GithubReleaseReader } from '../github'
import { ReleasePullReader } from '../pulls'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); resetOriginAllowlistForTests() })
const settings = { requestedEnabled: false, configuration: 'default' as const, warnings: [] }
const pull = 'https://github.com/owner/repo/pull/1', merge = 'a'.repeat(40)
function fixture() {
  const scene = fixtureScene(); scene.cards = scene.cards.slice(0, 2)
  for (const card of scene.cards) {
    card.source.properties.Status!.value = 'Waiting for Prod Release'
    card.source.properties.Link = { id: 'link', type: 'url', value: pull, hasMore: false }
  }
  scene.cards[0]!.source.properties.Owner!.value = 'Ada'
  scene.cards[0]!.source.properties['Requires production verification'] = { id: 'verify', type: 'checkbox', value: true, hasMore: false }
  const data = releaseAssociations(scene)
  Object.assign(data.pulls[0]!, { state: 'merged', freshness: 'fresh', mergeSha: merge })
  const receipt: DeploymentReceipt = { id: 'prod-1', repository: 'owner/repo', environment: 'production', component: 'api', target: 'api-prod', deployedSha: 'b'.repeat(40), artifactDigest: `sha256:${'c'.repeat(64)}`, version: 'v1', deployedAt: new Date().toISOString(), receiptUrl: 'https://example.com/receipts/1', workflowUrl: 'https://github.com/owner/repo/actions/runs/1', outcome: 'succeeded', exceptions: [] }
  const evidence: EvidenceRead = { status: 'fresh', collectedAt: receipt.deployedAt, warnings: [], receipts: [receipt], repositories: new Map([['owner/repo', '/existing/repo']]), requirements: new Map([['owner/repo#1', { targets: [{ component: 'api', target: 'api-prod' }], exceptions: [] }]]) }
  const reconcile = () => reconcileReleases(data, scene, evidence, async () => ({ state: 'ancestor' }))
  return { scene, data, evidence, receipt, reconcile }
}
async function root() {
  const root = await mkdtemp(join(tmpdir(), 'release-automation-'))
  await mkdir(join(root, 'releases'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

describe('default-OFF release transition and owner routing proposals', () => {
  it('defaults OFF and exposes the operator switch without executing writes', async () => {
    const config = await root(), file = join(config, 'releases', 'automation.json'), { scene, reconcile } = fixture(), data = await reconcile()
    expect(await readAutomationSettings(config)).toEqual(settings)
    for (const enabled of [false, true]) {
      const saved = JSON.stringify({ version: 1, enabled }); await writeFile(file, saved)
      const read = await readAutomationSettings(config), plan = planReleaseAutomation(data, scene, read)
      expect(read).toMatchObject({ configuration: 'configured', requestedEnabled: enabled })
      expect(plan).toMatchObject({ enabled, mode: enabled ? 'automatic' : 'review-only' })
      expect(plan.proposals).toHaveLength(2)
      expect(await readFile(file, 'utf8')).toBe(saved)
    }
    for (const invalid of ['{', JSON.stringify({ version: 1, enabled: 'true' }), JSON.stringify({ version: 2, enabled: true })]) {
      await writeFile(file, invalid)
      expect(await readAutomationSettings(config)).toMatchObject({ configuration: 'error', requestedEnabled: false })
    }
  })

  it('proposes independent Done and opt-in In Progress/owner Desk drafts with auditable component evidence', async () => {
    const { scene, data, evidence, reconcile } = fixture(), before = JSON.stringify({ scene, data, evidence }), plan = planReleaseAutomation(await reconcile(), scene, settings)
    const verify = plan.proposals.find(proposal => proposal.kind === 'verify-in-production')!, done = plan.proposals.find(proposal => proposal.kind === 'complete')!
    expect(done).toMatchObject({ from: 'Waiting for Prod Release', to: 'Done', desk: null })
    expect(verify).toMatchObject({ from: 'Waiting for Prod Release', to: 'In Progress', owner: 'Ada', desk: { owner: 'Ada', item: { kind: 'decision', readiness: 'future-or-conditional', oneTouch: false, cardIds: [scene.cards[0]!.id], decisionKeys: [] } } })
    expect(verify.desk!.item.sources.every(source => !source.responseAnchor && source.readiness === 'future-or-conditional')).toBe(true)
    expect(decisionItems({ ...buildQueue(fixtureSources()), items: [verify.desk!.item] })).toEqual([])
    expect(done.auditText).toContain(merge)
    for (const value of ['owner/repo', 'api-prod', 'v1', evidence.receipts[0]!.deployedSha!, evidence.receipts[0]!.artifactDigest!, evidence.receipts[0]!.deployedAt, evidence.receipts[0]!.workflowUrl, evidence.receipts[0]!.receiptUrl, pull]) expect(done.auditText).toContain(value)
    expect(verify.auditText).toContain('explicit owner verification is required')
    expect(verify.desk!.item.evidence).toEqual(expect.arrayContaining([{ url: pull, kind: 'pull-request' }, { url: evidence.receipts[0]!.receiptUrl, kind: 'reference' }]))
    expect(JSON.stringify({ scene, data, evidence })).toBe(before)
  })

  it('binds stable proposal identities to card/release/owner rather than polling timestamps or other cards', async () => {
    const { scene, evidence, reconcile } = fixture()
    const first = planReleaseAutomation(await reconcile(), scene, settings)
    evidence.collectedAt = new Date(Date.now() + 1000).toISOString()
    const replay = planReleaseAutomation(await reconcile(), scene, settings)
    expect(replay).toEqual(first)
    scene.cards[0]!.source.properties.Owner!.value = 'Grace'
    const reowned = planReleaseAutomation(await reconcile(), scene, settings)
    expect(reowned.proposals.find(p => p.kind === 'verify-in-production')!.id).not.toBe(first.proposals.find(p => p.kind === 'verify-in-production')!.id)
    expect(reowned.proposals.find(p => p.kind === 'complete')!.id).toBe(first.proposals.find(p => p.kind === 'complete')!.id)
    evidence.receipts[0]!.deployedSha = 'd'.repeat(40)
    expect(planReleaseAutomation(await reconcile(), scene, settings).proposals.every((p, i) => p.id !== reowned.proposals[i]!.id)).toBe(true)
  })

  it('requires every PR before either proposal and retains opt-in work open until a real check is recorded', async () => {
    const { scene, data, evidence, reconcile } = fixture()
    const second = { ...data.pulls[0]!, id: 'owner/repo#2', number: 2, url: 'https://github.com/owner/repo/pull/2' }; data.pulls.push(second)
    expect(planReleaseAutomation(await reconcile(), scene, settings).proposals).toEqual([])
    evidence.requirements.set(second.id, evidence.requirements.get(data.pulls[0]!.id)!)
    const plan = planReleaseAutomation(await reconcile(), scene, settings)
    expect(plan.proposals).toHaveLength(2)
    expect(plan.proposals.every(proposal => proposal.requiredPulls.length === 2)).toBe(true)
    // Merely opening or later observing an In Progress card is not an explicit check.
    scene.cards[0]!.source.properties.Status!.value = 'In Progress'
    expect(planReleaseAutomation(await reconcile(), scene, settings).proposals.map(p => p.cardId)).toEqual([scene.cards[1]!.id])
  })

  it.each(['stale', 'partial', 'rollback', 'flag', 'missing-link', 'missing-owner', 'archived', 'done'])('does not propose an unsafe %s transition', async variant => {
    const { scene, data, evidence, reconcile } = fixture()
    if (variant === 'stale') evidence.status = 'stale'
    if (variant === 'partial') evidence.receipts[0]!.outcome = 'partial'
    if (variant === 'rollback') evidence.receipts[0]!.outcome = 'rollback'
    if (variant === 'flag') evidence.requirements.get(data.pulls[0]!.id)!.exceptions.push('feature flag disabled')
    if (variant === 'missing-link') data.pulls = []
    if (variant === 'missing-owner') scene.cards[0]!.source.properties.Owner!.value = ''
    if (variant === 'archived') scene.cards[0]!.source.archived = true
    if (variant === 'done') scene.cards[0]!.source.properties.Status!.value = 'Done'
    const plan = planReleaseAutomation(await reconcile(), scene, settings)
    expect(plan.proposals.some(proposal => proposal.cardId === scene.cards[0]!.id)).toBe(false)
    if (!['missing-owner', 'archived', 'done'].includes(variant)) expect(plan.proposals).toEqual([])
  })

  it('does not reuse a decision after current status, checkbox or source coverage changes', async () => {
    const { scene, reconcile } = fixture(), data = await reconcile()
    scene.cards[0]!.source.properties['Requires production verification']!.value = false
    expect(planReleaseAutomation(data, scene, settings).proposals.map(p => p.cardId)).toEqual([scene.cards[1]!.id])
    scene.coverage.intentions.status = 'stale'
    expect(planReleaseAutomation(data, scene, settings).proposals).toEqual([])
  })

  it('serves only read-only automation reports over HTTP, even when configuration requests ON', async () => {
    const config = await root(), { scene, receipt } = fixture(), before = JSON.stringify(scene)
    await writeFile(join(config, 'releases', 'automation.json'), JSON.stringify({ version: 1, enabled: true }))
    const snapshot = join(config, 'snapshot.json')
    await writeFile(snapshot, JSON.stringify({ schema: 'tinstar.deployment-receipts.v1', collectedAt: receipt.deployedAt, receipts: [receipt] }))
    await writeFile(join(config, 'releases', 'reconciliation.json'), JSON.stringify({ version: 1, repositories: [{ repository: 'owner/repo', checkout: config }], requirements: [{ pull, targets: [{ target: receipt.target, component: receipt.component }] }], receiptFiles: [snapshot] }))
    const files = await readdir(config, { recursive: true })
    const api = new ReleasesApi({ scene: async () => ({ ...scene, searchIndex: { documents: [], notes: [] } }) }, config, new ReleasePullReader(async () => ({ title: 'Change', merged: true, state: 'closed', merge_commit_sha: merge, merged_at: receipt.deployedAt })), async () => [], new GithubReleaseReader(async () => []), new ReleaseReconciler(async () => ({ state: 'ancestor' })))
    const server = createServer((req, res) => { void api.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end() } }) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
    const port = (server.address() as { port: number }).port; seedOriginAllowlist(port)
    const url = `http://127.0.0.1:${port}/api/releases/automation`
    const first = await (await fetch(url)).json(), replay = await (await fetch(url)).json()
    expect(first.data).toEqual(replay.data)
    expect(first.data).toMatchObject({ mode: 'review-only', enabled: false, requestedEnabled: false, proposals: [] })
    expect(first.data.proposals).toHaveLength(0)
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) expect((await fetch(url, { method })).status).toBe(400)
    expect(JSON.stringify(scene)).toBe(before)
    expect(await readdir(config, { recursive: true })).toEqual(files)
    expect(await api.store.read()).toEqual([])
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReleaseEvidenceReader } from '../evidence'
const roots: string[] = [], collectedAt = '2026-11-06T18:15:00Z'
const receipt = { id: 'prod-1', repository: 'owner/repo', environment: 'production', target: 'api-prod', component: 'api', deployedSha: 'a'.repeat(40), artifactDigest: null, version: 'v1', deployedAt: '2026-11-06T18:10:00Z', workflowUrl: 'https://github.com/owner/repo/actions/runs/1', receiptUrl: 'https://example.com/receipt', outcome: 'succeeded' }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'release-evidence-')); roots.push(root); await mkdir(join(root, 'releases'))
  const file = join(root, 'snapshot.json'), settings = { version: 1, repositories: [{ repository: 'owner/repo', checkout: root }], requirements: [{ pull: 'https://github.com/owner/repo/pull/1', targets: [{ component: 'api', target: 'api-prod' }] }], receiptFiles: [file] }
  const snapshot = { schema: 'tinstar.deployment-receipts.v1', collectedAt, receipts: [receipt] }
  const save = async () => { await writeFile(join(root, 'releases', 'reconciliation.json'), JSON.stringify(settings)); await writeFile(file, JSON.stringify(snapshot)) }
  return { root, file, settings, snapshot, save }
}
describe('read-only production receipt snapshots', () => {
  it('degrades visibly when unconfigured, accepts replay without duplicate identities and detects stale current-state exports', async () => {
    const fixture = await setup(), reader = new ReleaseEvidenceReader(fixture.root, () => Date.parse(collectedAt))
    expect((await reader.get()).status).toBe('unconfigured')
    fixture.snapshot.receipts.push(receipt); await fixture.save()
    const current = await reader.get()
    expect(current).toMatchObject({ status: 'fresh', collectedAt, receipts: [expect.objectContaining({ id: 'prod-1' })] })
    expect(current.requirements.get('owner/repo#1')!.targets).toEqual([{ target: 'api-prod', component: 'api' }])
    expect((await new ReleaseEvidenceReader(fixture.root, () => Date.parse(collectedAt) + 301_000).get()).status).toBe('stale')
  })
  it('selects the earliest snapshot by instant across timezone offsets', async () => {
    const fixture = await setup()
    const earlier = '2026-11-06T19:14:00+01:00'
    const second = join(fixture.root, 'second.json')
    fixture.settings.receiptFiles.push(second)
    await fixture.save()
    await writeFile(second, JSON.stringify({ ...fixture.snapshot, collectedAt: earlier }))
    const result = await new ReleaseEvidenceReader(fixture.root, () => Date.parse(collectedAt)).get()
    expect(result).toMatchObject({ status: 'fresh', collectedAt: earlier })
  })
  it('does not treat a tag, malformed export, missing file or conflicting receipt as deployed evidence', async () => {
    const fixture = await setup(), reader = new ReleaseEvidenceReader(fixture.root, () => Date.parse(collectedAt))
    await fixture.save()
    await writeFile(fixture.file, JSON.stringify({ tag: 'v1' })); expect((await reader.get()).status).toBe('error')
    await fixture.save(); fixture.snapshot.receipts.push({ ...receipt, deployedSha: 'b'.repeat(40) }); await fixture.save()
    expect((await reader.get()).status).toBe('error')
    await rm(fixture.file); expect((await reader.get()).status).toBe('error')
  })
})

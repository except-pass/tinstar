import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readdir, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { acceptanceFixture } from '../../../../test-fixtures/releases/acceptance'
import { acceptanceKey, readAcceptanceContract } from '../../../shared/releaseAcceptance'
import { releaseChanges } from '../../../shared/releaseChanges'
import { ReleaseAcceptanceRunner, acceptanceGithub, readAcceptanceRecords, type AcceptanceSettings } from '../acceptance'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() })
const now = '2026-11-06T18:20:00Z'
const settings: AcceptanceSettings = { version: 1, enabled: true, checks: { 'siteconfig.avalon-enum.prod': {
  repository: 'fortresspower/cmsandbox', workflow: 'existing-smoke.yml', ref: 'main', productionSafe: true,
  inputs: { fixture: '{fixture}', targets: '{targets}', receipts: '{receiptIds}' },
} } }
async function setup(method: Parameters<typeof acceptanceFixture>[0] = 'workflow') {
  const root = await mkdtemp(join(tmpdir(), 'tinstar-acceptance-')); roots.push(root)
  const fixture = acceptanceFixture(method)
  // One explicit card for dispatch count; many-to-many grouping is tested below.
  fixture.pull.links = fixture.pull.links.slice(0, 1)
  const github = vi.fn().mockResolvedValue({ workflow_run_id: 42, html_url: 'https://github.com/fortresspower/cmsandbox/actions/runs/42' })
  const read = vi.fn(async () => { fixture.data.acceptanceRecords = await readAcceptanceRecords(root); return { data: fixture.data, scene: fixture.scene } })
  const runner = new ReleaseAcceptanceRunner(root, read, github, () => now)
  const change = releaseChanges(fixture.release, fixture.data, fixture.scene)[0]!, key = change.checks![0]!.key
  const configure = async (value = settings) => { await mkdir(join(root, 'releases'), { recursive: true }); await writeFile(join(root, 'releases', 'acceptance.json'), JSON.stringify(value)) }
  return { ...fixture, root, runner, github, read, key, configure }
}

describe('release acceptance safe checks', () => {
  it('defaults OFF, and dry-run creates no receipt and makes zero GitHub requests even when enabled', async () => {
    const f = await setup()
    expect(await f.runner.perform({ actor: 'owner' })).toEqual({ enabled: false, records: [] })
    expect(await readdir(f.root)).toEqual([])
    await f.configure()
    expect(await f.runner.plan()).toMatchObject({ enabled: true, zeroWrites: true, checks: [{ held: null, request: { body: { return_run_details: true } } }] })
    expect(f.github).not.toHaveBeenCalled()
    expect(await readAcceptanceRecords(f.root)).toEqual([])
  })
  it('persists intent before one fake dispatch, records exact run link, collects success and never repeats it', async () => {
    const f = await setup(); await f.configure()
    f.github.mockImplementationOnce(async () => {
      expect((await readAcceptanceRecords(f.root))[0]?.events.at(-1)?.outcome).toBe('inconclusive')
      return { workflow_run_id: 42, html_url: 'https://github.com/fortresspower/cmsandbox/actions/runs/42' }
    })
    await f.runner.perform({ actor: 'owner' })
    expect(f.github).toHaveBeenCalledWith('POST', '/repos/fortresspower/cmsandbox/actions/workflows/existing-smoke.yml/dispatches', expect.objectContaining({ ref: 'main', inputs: expect.objectContaining({ fixture: 'approved-read-only-fixture' }) }))
    f.github.mockResolvedValue({ id: 42, html_url: 'https://github.com/fortresspower/cmsandbox/actions/runs/42', event: 'workflow_dispatch', path: '.github/workflows/existing-smoke.yml', head_branch: 'main', created_at: now, status: 'completed', conclusion: 'success' })
    await f.runner.perform({ actor: 'owner' }); await f.runner.perform({ actor: 'owner' })
    expect(f.github).toHaveBeenCalledTimes(2)
    await f.read()
    expect(releaseChanges(f.release, f.data, f.scene)[0]).toMatchObject({ acceptance: 'Passed', checks: [{ outcome: 'passed', record: { events: expect.arrayContaining([expect.objectContaining({ runId: 42 })]) } }] })
  })
  it.each(['partial', 'skipped', 'rollback', 'failed'] as const)('does not dispatch for %s receipts', async outcome => {
    const f = await setup(); await f.configure(); f.release.targets[0]!.receipt!.outcome = outcome
    await f.runner.perform({ actor: 'owner' }); expect(f.github).not.toHaveBeenCalled()
  })
  it.each(['snapshot', 'stale', 'error'] as const)('does not dispatch from %s evidence', async sourceStatus => {
    const f = await setup(); await f.configure(); f.data.reconciliation!.sourceStatus = sourceStatus
    await f.runner.perform({ actor: 'owner' }); expect(f.github).not.toHaveBeenCalled()
  })
  it('holds tag-only, candidate, unknown mappings, flagged receipts, incomplete associations and a second required PR', async () => {
    const f = await setup(); await f.configure()
    const original = structuredClone(f.release)
    f.release.kind = 'candidate'; await f.runner.perform({ actor: 'owner' }); Object.assign(f.release, structuredClone(original))
    f.release.targets[0]!.receipt = null; await f.runner.perform({ actor: 'owner' }); Object.assign(f.release, structuredClone(original))
    f.release.targets[0]!.receipt!.exceptions.push('Feature flag is disabled'); await f.runner.perform({ actor: 'owner' }); Object.assign(f.release, structuredClone(original))
    f.data.associationsComplete = false; await f.runner.perform({ actor: 'owner' }); f.data.associationsComplete = true
    f.data.pulls[1]!.links = structuredClone(f.pull.links); await f.runner.perform({ actor: 'owner' })
    expect(f.github).not.toHaveBeenCalled()
  })
  it('keeps lost dispatch responses inconclusive across restart; audited retry is explicit', async () => {
    const f = await setup(); await f.configure(); f.github.mockRejectedValue(new Error('response lost'))
    await f.runner.perform({ actor: 'owner' }); await f.runner.perform({ actor: 'owner' })
    expect(f.github).toHaveBeenCalledTimes(1)
    expect((await readAcceptanceRecords(f.root))[0]!.events.at(-1)?.outcome).toBe('inconclusive')
    await expect(f.runner.perform({ actor: 'owner', key: f.key, action: 'retry' })).rejects.toThrow('reason')
    await f.runner.perform({ actor: 'owner', key: f.key, action: 'retry', reason: 'Inspected GitHub; no run exists' })
    expect(f.github).toHaveBeenCalledTimes(2)
  })
  it.each([['failure', 'failed'], ['skipped', 'skipped'], ['cancelled', 'inconclusive'], ['neutral', 'inconclusive'], [null, 'inconclusive']])('collects %s as %s, never inferring a pass', async (conclusion, outcome) => {
    const f = await setup(); await f.configure(); await f.runner.perform({ actor: 'owner' })
    f.github.mockResolvedValue({ id: 42, html_url: 'https://github.com/fortresspower/cmsandbox/actions/runs/42', event: 'workflow_dispatch', path: '.github/workflows/existing-smoke.yml', head_branch: 'main', created_at: now, status: 'completed', conclusion })
    await f.runner.perform({ actor: 'owner' })
    expect((await readAcceptanceRecords(f.root))[0]!.events.at(-1)?.outcome).toBe(outcome)
  })
  it('rejects unrelated or pre-deployment run evidence and supports audited attachment', async () => {
    const f = await setup(); await f.configure(); await f.runner.perform({ actor: 'owner' })
    f.github.mockResolvedValue({ id: 42, html_url: 'https://github.com/fortresspower/cmsandbox/actions/runs/42', event: 'workflow_dispatch', path: '.github/workflows/deploy.yml', head_branch: 'main', created_at: now, status: 'completed', conclusion: 'success' })
    await f.runner.perform({ actor: 'owner', key: f.key, action: 'attach', reason: 'Inspected exact run', runId: 42 })
    expect((await readAcceptanceRecords(f.root))[0]!.events.at(-1)?.outcome).toBe('inconclusive')
  })
  it('records named human results independently for cards sharing a PR, with evidence and history', async () => {
    const f = await setup('human'); f.pull.links.push({ cardId: f.scene.cards[1]!.id, active: true, sources: ['Explicit'], events: [] })
    await f.runner.perform({ actor: 'owner' }); expect(f.github).not.toHaveBeenCalled()
    await expect(f.runner.perform({ actor: 'reviewer', key: f.key, action: 'manual', reason: 'Observed feature', outcome: 'passed' })).rejects.toThrow('evidence')
    await f.runner.perform({ actor: 'reviewer', key: f.key, action: 'manual', reason: 'Assertion mismatch', evidence: 'https://example.com/failed-observation', outcome: 'failed' })
    await f.read(); expect(releaseChanges(f.release, f.data, f.scene).map(change => change.acceptance)).toEqual(['Failed', 'Human review'])
    await f.runner.perform({ actor: 'owner', key: f.key, action: 'manual', reason: 'Reviewed corrected fixture as an explicit exception', evidence: 'https://example.com/review', outcome: 'passed' })
    await f.read(); expect(releaseChanges(f.release, f.data, f.scene).map(change => change.acceptance)).toEqual(['Passed', 'Human review'])
    expect((await readAcceptanceRecords(f.root))[0]!.events.map(event => event.outcome)).toEqual(['failed', 'passed'])
  })
  it('requires every assertion, leaves candidates unexecuted and invalidates proof on meaningful changes only', async () => {
    const f = await setup('human')
    await f.runner.perform({ actor: 'owner', key: f.key, action: 'manual', outcome: 'passed', reason: 'Observed specific assertion', evidence: 'https://example.com/evidence' })
    await f.read(); expect(releaseChanges(f.release, f.data, f.scene)[0]!.acceptance).toBe('Passed')
    const change = releaseChanges(f.release, f.data, f.scene)[0]!
    expect(acceptanceKey({ ...f.release, observedAt: now }, change, change.checks![0]!)).toBe(f.key)
    const checks = [...f.contract.checks, { ...f.contract.checks[0]!, id: 'second-assertion' }]
    f.scene.cards[0]!.source.properties.Evidence!.value = '```production-acceptance\n' + JSON.stringify({ checks }) + '\n```'
    expect(releaseChanges(f.release, f.data, f.scene)[0]!.acceptance).toBe('Human review')
    f.release.id += ':new-attempt'; expect(releaseChanges(f.release, f.data, f.scene)[0]!.checks![0]!.outcome).toBe('missing')
    expect(readAcceptanceContract('{invalid').contract).toBeNull()
    expect(readAcceptanceContract({ checks: [{ id: 'a', successCondition: 'specific', ref: 'procedure', method: 'human' }] }).contract).toBeNull()
  })
  it('allows a verified subset of a partial rollout without certifying the missing target', async () => {
    const f = await setup(); await f.configure()
    const partial = acceptanceFixture('workflow', true)
    expect(partial.release.state).toBe('Partial rollout')
    expect(partial.release.targets).toHaveLength(2)
    partial.pull.links = partial.pull.links.slice(0, 1)
    const runner = new ReleaseAcceptanceRunner(f.root, async () => ({ data: partial.data, scene: partial.scene }), f.github, () => now)
    await runner.perform({ actor: 'owner' })
    expect(f.github).toHaveBeenCalledTimes(1)
    expect(partial.release.targets.filter(target => target.receipt?.outcome !== 'succeeded')).toHaveLength(1)
  })
  it('uses gh-axi with a JSON request and parses exact fake provider responses', async () => {
    const f = await setup()
    const executable = join(f.root, 'gh-axi')
    await writeFile(executable, `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
if(args[1]==='POST') { const body=JSON.parse(fs.readFileSync(args[args.indexOf('--input')+1], 'utf8'));if(body.return_run_details!==true)process.exit(4); }
process.stdout.write('payload: '+JSON.stringify(JSON.stringify({workflow_run_id:99,html_url:'https://github.com/fortresspower/cmsandbox/actions/runs/99'}))+'\\n');
`)
    await chmod(executable, 0o700)
    vi.stubEnv('PATH', `${f.root}:${process.env.PATH}`)
    expect(await acceptanceGithub('POST', '/repos/fortresspower/cmsandbox/actions/workflows/existing-smoke.yml/dispatches', { ref: 'main', return_run_details: true })).toMatchObject({ workflow_run_id: 99 })
  })
  it('an audited skip is recoverable and never becomes a pass', async () => {
    const f = await setup('human')
    await f.runner.perform({ actor: 'owner', key: f.key, action: 'skip', reason: 'Wait for reviewer availability' })
    await f.read(); expect(releaseChanges(f.release, f.data, f.scene)[0]!.acceptance).toBe('Skipped')
    await f.runner.perform({ actor: 'reviewer', key: f.key, action: 'manual', reason: 'Reviewed after availability restored', evidence: 'https://example.com/review', outcome: 'passed' })
    expect((await readAcceptanceRecords(f.root))[0]!.events).toHaveLength(2)
  })
})

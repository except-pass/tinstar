import { describe, expect, it } from 'vitest'
import { readerRepositories } from '../../../shared/actions'
import { appProfiles, SimulatedWriteAdapter, validateOperation, verifyFinalSquash } from '../broker'
import { validateChecks, cmsandboxCheckPolicy } from '../checkPolicy'
import recorded from '../../../../data/tinstar-pr-ops-actions/recorded-checks.v1.json'
import { head, baseHead, snapshot, installed, merge, invocation, policy, check } from './fixtures'
const webFmp = 'components/web-fmp/src/example.ts'
const requiredFor = (path: string) => {
  const matching = cmsandboxCheckPolicy.workloads.filter(workload => workload.complete && workload.prefixes.some(prefix => path.startsWith(prefix)) && !workload.excludedPrefixes.some(prefix => path.startsWith(prefix)))
  return [...cmsandboxCheckPolicy.common, ...matching.flatMap(workload => workload.checks)].map((identity, index) => ({ ...check, id: index + 1, name: identity.name, appId: identity.appId, appSlug: identity.appSlug }))
}
const reasons = (changes: Partial<ReturnType<typeof snapshot>> = {}, operation: unknown = merge) => validateOperation(installed(), snapshot(), { ...snapshot(), ...changes }, operation, invocation, policy).reasons

describe('dedicated app broker boundary', () => {
  it('models exactly ten read repositories and no ambient admin or write permissions on Reader', () => {
    expect(readerRepositories).toHaveLength(10)
    expect(readerRepositories).not.toContain('kunchenguid/firstmate')
    expect(Object.values(appProfiles.Reader.permissions).every(value => value === 'read')).toBe(true)
    for (const profile of Object.values(appProfiles)) expect(profile.permissions).not.toHaveProperty('administration')
    expect(appProfiles.Merge.repositories).toEqual(['fortresspower/cmsandbox'])
    expect(appProfiles.Repair.permissions.actions).toBe('write')
  })
  it('simulates explicit squash bound to expected head with only approved PR rule scope', () => {
    expect(reasons()).toEqual(['Admin Merge is globally disabled; no live Merge adapter exists'])
    expect(new SimulatedWriteAdapter().perform(snapshot(), merge)).toMatchObject({ actualGitHubWrites: 0, resultingSha: null, verification: 'not-performed', providerRequest: { method: 'PUT', path: '/repos/fortresspower/cmsandbox/pulls/1/merge', body: { merge_method: 'squash', sha: head }, ruleScope: { id: 6108448, mode: 'pull_request' } } })
  })
  it.each([
    { ...merge, method: 'merge' }, { ...merge, method: 'rebase' }, { ...merge, ruleset: 12095487 }, { ...merge, bypassMode: 'always' },
    { ...merge, bypassChecks: true }, { kind: 'push', force: true }, { kind: 'delete' }, { kind: 'bulk', targets: [1, 2] }, { kind: 'shell', command: 'gh pr merge' },
  ])('refuses operation outside exact scope: %j', operation => { expect(reasons({}, operation).length).toBeGreaterThan(0) })
  it.each([
    { head: 'c'.repeat(40) }, { base: 'other' }, { baseHead: 'c'.repeat(40) }, { state: 'merged' as const }, { draft: true }, { pendingMerge: true }, { pendingMerge: null },
    { threadsResolved: false }, { threadsResolved: null }, { rulesVerified: false }, { observedAt: '2000-01-01T00:00:00Z' },
    { repository: 'except-pass/tinstar' }, { id: 'fortresspower/cmsandbox#2' }, { number: 2 },
  ])('refuses changed or unproven selected state: %j', changes => { expect(reasons(changes).length).toBeGreaterThan(0) })
  it('rejects missing grant, version mismatch, narrowed paths and automatic merge after Ask', () => {
    const action = installed(); action.grant.capabilities = []
    expect(validateOperation(action, snapshot(), snapshot(), merge, invocation, policy).reasons.join()).toContain('Missing installed capability')
    action.grant.version = 'v0'
    expect(validateOperation(action, snapshot(), snapshot(), merge, invocation, policy).reasons.join()).toContain('version/grant')
    action.grant.paths = ['docs/**']
    expect(validateOperation(action, snapshot(), snapshot(), merge, invocation, policy).reasons.join()).toContain('Changed path')
    expect(validateOperation(installed(), snapshot(), snapshot(), merge, { ...invocation, origin: 'ask-answer' }, policy).reasons.join()).toContain('Ask answer')
  })
  it.each(['main', 'refs/tags/v1', 'release/protected'])('never repairs forbidden head ref %s', headRef => {
    const selected = { ...snapshot(), headRef }
    expect(validateOperation(installed('fix-ci'), selected, selected, { kind: 'repair.update', ref: `refs/heads/${headRef}`, expectedHead: head }, invocation, policy).reasons.join()).toContain('Repair requires')
  })
  it('models safe update-branch and exactly one failed job at selected head and run', () => {
    const update = { kind: 'repair.update', expectedHead: head, ref: 'refs/heads/feature-1' }
    expect(validateOperation(installed('fix-ci'), snapshot(), snapshot(), update, invocation, policy).reasons).toEqual([])
    expect(new SimulatedWriteAdapter().perform(snapshot(), update as never).providerRequest?.body).toEqual({ expected_head_sha: head })
    const operation = { kind: 'repair.rerun', jobId: 123, runId: 456, expectedHead: head, attempt: 1 }
    const job = { id: 123, runId: 456, head, status: 'completed', conclusion: 'failure', runAttempt: 1, dependentJobs: [] }
    expect(validateOperation(installed('fix-ci'), snapshot(), snapshot(), operation, { ...invocation, job }, policy).reasons).toEqual([])
    for (const invalid of [{ ...job, dependentJobs: null }, { ...job, dependentJobs: [99] }, { ...job, runAttempt: 2 }, { ...job, runId: 789 }, { ...job, conclusion: 'success' }, { ...job, head: baseHead }]) expect(validateOperation(installed('fix-ci'), snapshot(), snapshot(), operation, { ...invocation, job: invalid }, policy).reasons.length).toBeGreaterThan(0)
  })
})
describe('mandatory check inventory', () => {
  it.each(['failure', 'skipped', 'cancelled', 'timed_out', 'neutral', null])('blocks required check conclusion %s', conclusion => {
    expect(validateChecks({ ...snapshot(), checks: [{ ...check, conclusion }] }, policy).length).toBeGreaterThan(0)
  })
  it.each(['queued', 'in_progress', 'pending', 'requested', 'waiting'])('blocks %s', status => { expect(validateChecks({ ...snapshot(), checks: [{ ...check, status, conclusion: null }] }, policy).length).toBeGreaterThan(0) })
  it('blocks missing, stale, wrong publisher, empty inventory, unknown paths and partial evidence', () => {
    for (const changes of [{ checks: [] }, { checks: [{ ...check, head: baseHead }] }, { checks: [{ ...check, appId: 9 }] }, { checksComplete: false }, { changedPaths: ['unmapped/x'] }, { pathsComplete: false }]) expect(validateChecks({ ...snapshot(), ...changes }, policy).length).toBeGreaterThan(0)
    expect(validateChecks(snapshot(), { ...policy, common: [], workloads: [] })).not.toEqual([])
    expect(cmsandboxCheckPolicy.version).toBe('cmsandbox-ci-2026-11-08-v2')
    expect(cmsandboxCheckPolicy.common.length).toBeGreaterThan(0)
    expect(cmsandboxCheckPolicy.workloads.some(row => row.complete)).toBe(true)
    expect(cmsandboxCheckPolicy.workloads.some(row => !row.complete)).toBe(true)
    expect(validateChecks({ ...snapshot(), changedPaths: ['libs/fuzzy-search/src/index.ts'] }, cmsandboxCheckPolicy).join()).toContain('Admin Merge disabled')
  })
  it('globally refuses the shipped incomplete inventory even for green completed workloads', () => {
    for (const workload of cmsandboxCheckPolicy.workloads.filter(row => row.complete)) {
      const path = workload.prefixes.find(prefix => !workload.excludedPrefixes.some(excluded => prefix.startsWith(excluded)))!
      const selected = { ...snapshot(), changedPaths: [path], checks: requiredFor(path) }
      const refusal = `Admin Merge disabled: incomplete check inventory ${cmsandboxCheckPolicy.version}`
      expect(validateChecks(selected, cmsandboxCheckPolicy)).toContain(refusal)
      expect(validateOperation(installed(), selected, selected, merge, invocation, cmsandboxCheckPolicy).reasons).toContain(refusal)
    }
  })
  it('allows a disposable complete workload fixture and refuses each blocking state', () => {
    const fixturePolicy = { ...cmsandboxCheckPolicy, version: 'disposable-web-fmp-fixture', workloads: cmsandboxCheckPolicy.workloads.filter(workload => workload.complete && workload.prefixes.some(prefix => webFmp.startsWith(prefix)) && !workload.excludedPrefixes.some(prefix => webFmp.startsWith(prefix))) }
    const checks = requiredFor(webFmp)
    const requiredCheck = checks[0]
    if (!requiredCheck) throw new Error('Disposable workload fixture requires a nonempty check inventory')
    const selected = { ...snapshot(), changedPaths: [webFmp], checks }
    expect(validateOperation(installed(), selected, selected, merge, invocation, fixturePolicy).reasons).toEqual(['Admin Merge is globally disabled; no live Merge adapter exists'])
    for (const conclusion of ['failure', 'skipped', 'cancelled', 'timed_out', 'neutral', null]) expect(validateChecks({ ...selected, checks: [{ ...requiredCheck, conclusion }, ...checks.slice(1)] }, fixturePolicy).length).toBeGreaterThan(0)
    for (const status of ['queued', 'in_progress', 'pending', 'requested', 'waiting']) expect(validateChecks({ ...selected, checks: [{ ...requiredCheck, status, conclusion: null }, ...checks.slice(1)] }, fixturePolicy).length).toBeGreaterThan(0)
    expect(validateChecks({ ...selected, checks: checks.slice(1) }, fixturePolicy).join()).toContain('Missing required check')
    expect(validateChecks({ ...selected, checks: [{ ...requiredCheck, head: baseHead }, ...checks.slice(1)] }, fixturePolicy).join()).toContain('Stale check')
    expect(validateChecks({ ...selected, checks: [{ ...requiredCheck, appId: 9 }, ...checks.slice(1)] }, fixturePolicy).join()).toContain('Missing required check')
  })
  it('refuses the actual failing GitHub checks recorded on a real PR, even when a synthetic coverage policy is complete', () => {
    const real = recorded.pulls.find(row => row.pull === 'https://github.com/fortresspower/cmsandbox/pull/3328')!
    const failure = real.data.check_runs.find(row => row.name === 'build-frontend' && row.conclusion === 'failure')!
    expect(failure.details_url).toBe('https://github.com/fortresspower/cmsandbox/actions/runs/42500300993/job/128791664221')
    const selected = { ...snapshot(3328), head: failure.head_sha, checks: [{ id: failure.id, name: failure.name, head: failure.head_sha, appId: failure.app.id, appSlug: failure.app.slug, status: failure.status, conclusion: failure.conclusion, url: failure.details_url, startedAt: failure.started_at, completedAt: failure.completed_at }] }
    const exact = { ...policy, common: [{ name: failure.name, appId: failure.app.id, appSlug: failure.app.slug }] }
    const validation = validateOperation(installed(), selected, selected, { ...merge, expectedHead: failure.head_sha }, invocation, exact)
    expect(validation.reasons.join()).toContain('Required check build-frontend: failure')
  })
})
it('final SHA verification refuses pending acknowledgments, wrong head/base/commit and merge commits', () => {
  const final = 'd'.repeat(40), expected = { head, base: 'main' }, response = { merged: true, sha: final }
  const observed = { merged: true, head, base: 'main', mergeSha: final, commitSha: final, parents: [baseHead] }
  expect(verifyFinalSquash(expected, response, observed)).toBe(true)
  expect(verifyFinalSquash(expected, { ...response, merged: false }, observed)).toBe(false)
  for (const changed of [{ merged: false }, { head: baseHead }, { base: 'other' }, { mergeSha: baseHead }, { commitSha: baseHead }, { parents: [head, baseHead] }]) expect(verifyFinalSquash(expected, response, { ...observed, ...changed })).toBe(false)
})

import { describe, expect, it, vi } from 'vitest'
import { GithubReleaseReader, nativeReleaseSummary } from '../github'
import { releaseAssociations } from '../../../shared/releases'
import { releaseChanges } from '../../../shared/releaseChanges'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { nativeBase, nativeBody, nativeFixtureRead, nativeHead, nativeRecord, nativeRepo, nativeRun, nativeTags, nativeTime } from '../../../../test-fixtures/releases/github-native'

const data = () => releaseAssociations(fixtureScene())
const now = Date.parse(nativeTime)
describe('GitHub-native releases', () => {
  it('shows the real historical tag and component runs without requiring a GitHub Release record or export', async () => {
    const read = vi.fn(nativeFixtureRead())
    const result = await new GithubReleaseReader(read, () => now).get(data())
    const release = result.releases[0]!
    expect(release).toMatchObject({ id: `${nativeRepo}:tag:v1.24.0`, kind: 'production', sourceSha: nativeHead, state: 'Awaiting PROD verification', targets: [], scope: ['components/ra-command/app.ts'], github: { record: 'missing', runsStatus: 'fresh' }, membership: { status: 'complete', baseline: 'v1.22.0' } })
    expect(release.github!.runs[0]).toMatchObject({ conclusion: 'success', attempt: 1, startedAt: nativeRun.run_started_at, updatedAt: nativeRun.updated_at })
    expect(release.pulls.map(pull => pull.number)).toEqual([3267])
    expect(result.releases.map(release => release.version)).not.toContain('deploy/v1.24.0-siteconfig-1')
    const changes = releaseChanges(release, data(), fixtureScene())
    expect(changes[0]).toMatchObject({ delivery: 'Unknown', acceptance: 'Unknown' })
    expect(read.mock.calls.every(([path]) => path.startsWith(`/repos/${nativeRepo}/`))).toBe(true)
  })
  it('excludes prerelease, suffixed, unprefixed and extra-segment tags from release history', async () => {
    const excluded = ['v1.25.0-rc1', 'v1.25.0+build', 'v1.25.0.1', '1.25.0']
    const tags = [...nativeTags, ...excluded.map(name => ({ name, commit: { sha: 'd'.repeat(40) } }))]
    const result = await new GithubReleaseReader(nativeFixtureRead({ tags }), () => now).get(data())
    expect(result.releases.map(release => release.version)).toEqual(['v1.24.0', 'v1.22.0'])
  })
  it('retains the GitHub Release body, component result table and snapshot without certifying deployment', async () => {
    const result = await new GithubReleaseReader(nativeFixtureRead({ records: [nativeRecord] }), () => now).get(data())
    expect(result.releases[0]!.github).toMatchObject({ record: 'available', body: nativeBody, publishedAt: nativeTime, snapshotAt: nativeTime, componentResults: [{ component: 'ra-command', result: 'completed — awaiting PROD verification', url: nativeRun.html_url }] })
    expect(result.releases[0]!.targets).toEqual([])
    expect(nativeReleaseSummary('| fake | passed | [run](https://github.com/example) |').componentResults).toEqual([])
  })
  it('keeps failed component runs and ignores same-SHA DEV, surgical and record-only activity', async () => {
    const runs = [nativeRun, { ...nativeRun, id: 42644285624, name: 'Utility MessageBus', path: '.github/workflows/utility-messagebus.yml', conclusion: 'failure' }, { ...nativeRun, id: 2, head_branch: 'main' }, { ...nativeRun, id: 3, event: 'workflow_dispatch' }, { ...nativeRun, id: 4, path: '.github/workflows/release-production.yml' }, { ...nativeRun, id: 5, head_sha: nativeBase }]
    const release = (await new GithubReleaseReader(nativeFixtureRead({ runs }), () => now).get(data())).releases[0]!
    expect(release.state).toBe('Failed/unfinished components')
    expect(release.github!.runs).toHaveLength(2)
    expect(release.targets).toEqual([])
  })
  it('uses the newest run per workflow for state while retaining earlier attempts for audit', async () => {
    const runs = [{ ...nativeRun, conclusion: 'failure' }, { ...nativeRun, id: nativeRun.id + 1, conclusion: 'success' }]
    const release = (await new GithubReleaseReader(nativeFixtureRead({ runs }), () => now).get(data())).releases[0]!
    expect(release.state).toBe('Awaiting PROD verification')
    expect(release.github!.runs).toHaveLength(2)
  })
  it('reports unreadable catalogs as unknown and never treats a failed Release read as a missing record', async () => {
    const read = vi.fn().mockRejectedValue(new Error('private credentials stderr'))
    const unknown = await new GithubReleaseReader(read, () => now).get(data())
    expect(unknown).toMatchObject({ status: 'unknown', releases: [] })
    expect(JSON.stringify(unknown)).not.toContain('private credentials')
    const fixture = nativeFixtureRead()
    const partial = await new GithubReleaseReader(async path => {
      if (path.includes('/releases?')) throw new Error('unreadable')
      return fixture(path)
    }, () => now).get(data())
    expect(partial.releases[0]!.github!.record).toBe('unknown')
    expect(partial.status).toBe('partial')
  })
  it('keeps an unreadable Actions source unknown and preserves last-known tag history on source loss', async () => {
    let clock = now, failed = false
    const fixture = nativeFixtureRead()
    const reader = new GithubReleaseReader(async path => {
      if (failed) throw new Error('unreadable')
      return fixture(path)
    }, () => clock)
    await reader.get(data()); clock += 61_000; failed = true
    const retained = await reader.get(data())
    expect(retained).toMatchObject({ status: 'unknown' })
    expect(retained.releases[0]).toMatchObject({ version: 'v1.24.0', provenance: { historical: true } })
    const missingRuns = await new GithubReleaseReader(async path => {
      if (path.includes('/actions/runs?')) throw new Error('no access')
      return fixture(path)
    }, () => now).get(data())
    expect(missingRuns.releases[0]).toMatchObject({ state: 'Unknown', kind: 'draft', github: { runsStatus: 'unknown' } })
  })
  it('discovers new tags on refresh without configuration and keeps a tag without runs a Draft', async () => {
    let clock = now, tags = nativeTags
    const reader = new GithubReleaseReader(path => nativeFixtureRead({ tags })(path), () => clock)
    await reader.get(data())
    tags = [{ name: 'v1.25.0', commit: { sha: 'd'.repeat(40) } }, ...nativeTags]; clock += 61_000
    const release = (await reader.get(data())).releases[0]!
    expect(release).toMatchObject({ version: 'v1.25.0', kind: 'draft', state: 'Deployment unknown', targets: [] })
  })
})

it('prioritizes the selected historical tag without waiting for the background history rotation', async () => {
  const tags = [...nativeTags, { name: 'v1.21.0', commit: { sha: 'e'.repeat(40) } }]
  const read = vi.fn(nativeFixtureRead({ tags }))
  const reader = new GithubReleaseReader(read, () => now)
  await reader.get(data())
  read.mockClear()
  await reader.get(data(), 'v1.21.0')
  expect(read.mock.calls.some(([path]) => path.includes(`/actions/runs?head_sha=${'e'.repeat(40)}`))).toBe(true)
})


it('shows an existing draft Release record rather than claiming it is missing', async () => {
  const result = await new GithubReleaseReader(nativeFixtureRead({ records: [{ ...nativeRecord, draft: true, published_at: null }] }), () => now).get(data())
  expect(result.releases[0]!.github).toMatchObject({ record: 'available', body: nativeBody, publishedAt: null })
})


it.each([undefined, 'v1.22.0'])('reads a concurrent historical selection before caching it after %s', async firstTag => {
  const historicalSha = 'e'.repeat(40)
  const tags = [...nativeTags, { name: 'v1.21.0', commit: { sha: historicalSha } }]
  let releaseFirst!: () => void, releaseSecond!: () => void, secondStarted!: () => void
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
  const started = new Promise<void>(resolve => { secondStarted = resolve })
  const fixture = nativeFixtureRead({ tags })
  const read = vi.fn(async (path: string) => {
    if (path.includes(`/actions/runs?head_sha=${nativeHead}`)) await firstGate
    if (path.includes(`/actions/runs?head_sha=${historicalSha}`)) {
      secondStarted()
      await secondGate
    }
    return fixture(path)
  })
  const reader = new GithubReleaseReader(read, () => now)
  const first = reader.get(data(), firstTag)
  let resolved = false
  const second = reader.get(data(), 'v1.21.0').then(result => { resolved = true; return result })
  const sameSelection = reader.get(data(), 'v1.21.0')
  releaseFirst()
  await first
  await Promise.race([started, second])
  expect(resolved).toBe(false)
  releaseSecond()
  const [result, shared] = await Promise.all([second, sameSelection])
  expect(result.releases.find(release => release.version === 'v1.21.0')?.github?.runsStatus).toBe('fresh')
  expect(shared).toEqual(result)
  expect(read.mock.calls.filter(([path]) => path.includes(`/actions/runs?head_sha=${historicalSha}`))).toHaveLength(1)
  const count = read.mock.calls.length
  await reader.get(data(), 'v1.21.0')
  expect(read).toHaveBeenCalledTimes(count)
})

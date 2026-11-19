import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { GithubReleaseReader, nativeReleaseSummary } from '../github'
import { ReleaseMembershipReader } from '../membership'
import { ReleasesApi } from '../routes'
import * as bind from '../../bind'
import { CockpitFleet } from '../../fleet/cockpit'
import { ObservabilityStack } from '../../observability'
import { CodexOtelReceiver } from '../../observability/codex-otel'
import { QuotaAxiPoller } from '../../quota/poller'
import { ReachCoordinator, resetReachCoordinatorForTests } from '../../reach'
import { ReconciliationSources } from '../../reconciliation'
import { DecisionPreparation } from '../../reconciliation/decisionPrep'
import { WaitingOnMain } from '../../reconciliation/waitingOnMain'
import { startServer } from '../../standalone'
import { OtlpExporter } from '../../stores/otlp-exporter'
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
    expect(result.releases.filter(release => release.kind === 'production').map(release => release.version)).toEqual(['v1.24.0', 'v1.22.0'])
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
    await reader.get(data()); clock += 120_000; failed = true
    const retained = await reader.get(data())
    expect(retained).toMatchObject({ status: 'unknown' })
    expect(retained.releases[0]).toMatchObject({ version: 'v1.24.0', provenance: { historical: true } })
    const missingRuns = await new GithubReleaseReader(async path => {
      if (path.includes('/actions/runs?')) throw new Error('no access')
      return fixture(path)
    }, () => now).get(data())
    expect(missingRuns.releases[0]).toMatchObject({ state: 'Unknown', kind: 'production', github: { runsStatus: 'unknown' } })
  })
  it('discovers new tags on refresh without configuration and keeps a tag without runs in history', async () => {
    let clock = now, tags = nativeTags
    const reader = new GithubReleaseReader(path => nativeFixtureRead({ tags })(path), () => clock)
    await reader.get(data())
    tags = [{ name: 'v1.25.0', commit: { sha: 'd'.repeat(40) } }, ...nativeTags]
    clock += 119_999
    expect((await reader.get(data())).releases[0]!.version).toBe('v1.24.0')
    clock += 1
    const release = (await reader.get(data())).releases[0]!
    expect(release).toMatchObject({ version: 'v1.25.0', kind: 'production', state: 'Deployment unknown', targets: [] })
  })
})

it('reuses prefetched historical Actions while enriching the selected release membership', async () => {
  const tags = [...nativeTags, { name: 'v1.21.0', commit: { sha: 'e'.repeat(40) } }]
  const read = vi.fn(nativeFixtureRead({ tags }))
  const reader = new GithubReleaseReader(read, () => now)
  await reader.get(data())
  read.mockClear()
  const result = await reader.get(data(), 'v1.21.0')
  expect(result.releases.find(release => release.version === 'v1.21.0')).toMatchObject({ github: { runsStatus: 'fresh' }, membership: { status: 'unknown' } })
  expect(read.mock.calls.some(([path]) => path.includes(`/actions/runs?head_sha=${'e'.repeat(40)}`))).toBe(false)
})


it('re-reads an open selected tag on the fast cadence and leaves settled tags until the catalog interval', async () => {
  const older = Array.from({ length: 5 }, (_, index) => ({
    name: `v1.${20 - index}.0`, commit: { sha: String(index + 1).repeat(40) },
  }))
  const selected = older[4]!
  let clock = now, selectedRunning = true
  const fixture = nativeFixtureRead({ tags: [...nativeTags, ...older] })
  const read = vi.fn(async (path: string) => {
    if (path.includes(`/actions/runs?head_sha=${selected.commit.sha}`)) {
      return { total_count: 1, workflow_runs: [{ ...nativeRun, head_sha: selected.commit.sha, head_branch: selected.name, status: selectedRunning ? 'in_progress' : 'completed', conclusion: selectedRunning ? null : 'success' }] }
    }
    return fixture(path)
  })
  const reader = new GithubReleaseReader(read, () => clock)
  await reader.get(data(), selected.name)
  read.mockClear()
  clock += 60_000
  selectedRunning = false
  const running = await reader.get(data(), selected.name)
  expect(running.releases.find(release => release.version === selected.name)?.github?.runsStatus).toBe('fresh')
  const fastPaths = read.mock.calls.map(([path]) => path)
  expect(fastPaths).toEqual([expect.stringContaining(`/actions/runs?head_sha=${selected.commit.sha}`)])
  expect(fastPaths.some(path => path.includes(older[3]!.commit.sha))).toBe(false)
  read.mockClear()
  clock += 60_000
  await reader.get(data(), selected.name)
  const settledPaths = read.mock.calls.map(([path]) => path)
  expect(settledPaths.some(path => path.includes(`/actions/runs?head_sha=${selected.commit.sha}`))).toBe(false)
  expect(settledPaths.some(path => path.includes(`/actions/runs?head_sha=${nativeHead}`))).toBe(true)
  read.mockClear()
  clock += 60_000
  await reader.get(data(), selected.name)
  expect(read.mock.calls.map(([path]) => path)).toEqual([expect.stringContaining(`/actions/runs?head_sha=${selected.commit.sha}`)])
})

it.each([
  { path: '.github/workflows/release-production.yml@refs/tags/v1.24.0' },
  { event: 'workflow_dispatch' },
  { head_sha: nativeBase },
  { head_branch: 'main' },
])('keeps Actions fresh on the slow cadence with excluded run %j', async exclusion => {
  let clock = now
  const hidden = { ...nativeRun, ...exclusion, id: 9, status: 'in_progress', conclusion: null }
  const read = vi.fn(nativeFixtureRead({ runs: [nativeRun, hidden] }))
  const reader = new GithubReleaseReader(read, () => clock)
  const first = await reader.get(data())
  expect(first.releases[0]!.github!.runs.map(run => run.id)).not.toContain(9)
  read.mockClear()
  clock += 60_000
  const display = reader.display(data())
  expect(display.refreshing).toBe(false)
  expect(display.releases[0]).toMatchObject({ provenance: { historical: false }, github: { runsStatus: 'fresh' } })
  await reader.get(data())
  expect(read.mock.calls.some(([path]) => path.includes(`/actions/runs?head_sha=${nativeHead}`))).toBe(false)
})

it.each([
  { status: 'completed', conclusion: 'success', pagesAfterMinute: 0 },
  { status: 'in_progress', conclusion: null, pagesAfterMinute: 10 },
])('keeps incomplete Actions evidence unknown with a $status component', async ({ status, conclusion, pagesAfterMinute }) => {
  let clock = now
  const fixture = nativeFixtureRead()
  const candidatePath = `/actions/runs?head_sha=${nativeHead}`
  const read = vi.fn(async (path: string) => {
    if (!path.includes(candidatePath)) return fixture(path)
    return { total_count: 11, workflow_runs: [{ ...nativeRun, status, conclusion }] }
  })
  const reader = new GithubReleaseReader(read, () => clock)
  const initial = await reader.get(data())
  expect(initial.releases[0]).toMatchObject({ provenance: { historical: true }, github: { runsStatus: 'unknown' } })
  read.mockClear()
  clock += 60_000
  await reader.get(data())
  expect(read.mock.calls.filter(([path]) => path.includes(candidatePath))).toHaveLength(pagesAfterMinute)
})

it.each([
  { path: nativeRun.path, callsAfterMinute: 2 },
  { path: '.github/workflows/release-production.yml', callsAfterMinute: 0 },
])('uses activity from the first Actions page with workflow $path when page two fails', async ({ path, callsAfterMinute }) => {
  let clock = now
  const fixture = nativeFixtureRead()
  const candidatePath = `/actions/runs?head_sha=${nativeHead}`
  const read = vi.fn(async (request: string) => {
    if (!request.includes(candidatePath)) return fixture(request)
    if (request.endsWith('&page=2')) throw new Error('unreadable')
    return { total_count: 101, workflow_runs: [
      { ...nativeRun, path, status: 'in_progress', conclusion: null },
      ...Array.from({ length: 99 }, (_, index) => ({ ...nativeRun, id: index + 1 })),
    ] }
  })
  const reader = new GithubReleaseReader(read, () => clock)
  const candidateCalls = () => read.mock.calls.filter(([request]) => request.includes(candidatePath))
  const initial = await reader.get(data())
  expect(candidateCalls()).toHaveLength(2)
  expect(initial.releases[0]).toMatchObject({ provenance: { historical: true }, github: { runsStatus: 'unknown' } })
  read.mockClear()
  clock += 60_000
  const next = await reader.get(data())
  expect(candidateCalls()).toHaveLength(callsAfterMinute)
  expect(next.releases[0]?.github?.runsStatus).toBe('unknown')
})

it('falls back to the slow cadence after failing to refresh an active component', async () => {
  let clock = now, failed = false
  const fixture = nativeFixtureRead({ runs: [{ ...nativeRun, status: 'in_progress', conclusion: null }] })
  const candidatePath = `/actions/runs?head_sha=${nativeHead}`
  const read = vi.fn(async (path: string) => {
    if (failed && path.includes(candidatePath)) throw new Error('unreadable')
    return fixture(path)
  })
  const reader = new GithubReleaseReader(read, () => clock)
  const initial = await reader.get(data())
  clock += 60_000
  failed = true
  const unavailable = await reader.get(data())
  expect(unavailable.releases[0]).toMatchObject({
    provenance: { historical: true },
    github: { runsStatus: 'unknown', runs: initial.releases[0]!.github!.runs },
  })
  read.mockClear()
  clock += 60_000
  await reader.get(data())
  expect(read.mock.calls.some(([path]) => path.includes(candidatePath))).toBe(false)
  clock += 60_000
  failed = false
  const recovered = await reader.get(data())
  expect(recovered.releases[0]).toMatchObject({ state: 'Running', github: { runsStatus: 'fresh' } })
})

it('re-reads a settled candidate on the slow cadence', async () => {
  let clock = now
  const read = vi.fn(nativeFixtureRead())
  const reader = new GithubReleaseReader(read, () => clock)
  await reader.get(data())
  const candidateCalls = () => read.mock.calls.filter(([path]) => path.includes(`/actions/runs?head_sha=${nativeHead}`))
  expect(candidateCalls()).toHaveLength(1)
  read.mockClear()
  clock += 60_000
  const settled = await reader.get(data())
  expect(candidateCalls()).toHaveLength(0)
  expect(settled.releases[0]).toMatchObject({ state: 'Awaiting PROD verification', github: { runsStatus: 'fresh' } })
  read.mockClear()
  clock += 60_000
  await reader.get(data())
  expect(candidateCalls()).toHaveLength(1)
})

it('shows an existing draft Release record rather than claiming it is missing', async () => {
  const result = await new GithubReleaseReader(nativeFixtureRead({ records: [{ ...nativeRecord, draft: true, published_at: null }] }), () => now).get(data())
  expect(result.releases[0]!.kind).toBe('draft')
  expect(result.releases[0]!.github).toMatchObject({ record: 'available', body: nativeBody, publishedAt: null })
})


it.each([undefined, 'v1.22.0'])('reads a concurrent historical selection before caching it after %s', async firstTag => {
  const historicalSha = 'e'.repeat(40)
  const tags = [...nativeTags, ...['v1.21.0', 'v1.20.0', 'v1.19.0'].map((name, index) => ({ name, commit: { sha: String(index + 1).repeat(40) } })), { name: 'v1.0.0', commit: { sha: historicalSha } }]
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
  const second = reader.get(data(), 'v1.0.0').then(result => { resolved = true; return result })
  const sameSelection = reader.get(data(), 'v1.0.0')
  releaseFirst()
  await first
  await Promise.race([started, second])
  expect(resolved).toBe(false)
  releaseSecond()
  const [result, shared] = await Promise.all([second, sameSelection])
  expect(result.releases.find(release => release.version === 'v1.0.0')?.github?.runsStatus).toBe('fresh')
  expect(shared).toEqual(result)
  expect(read.mock.calls.filter(([path]) => path.includes(`/actions/runs?head_sha=${historicalSha}`))).toHaveLength(1)
  const count = read.mock.calls.length
  await reader.get(data(), 'v1.0.0')
  expect(read).toHaveBeenCalledTimes(count)
})

it('keeps a prerelease record out of production even with a stable-looking tag', async () => {
  const prerelease = { ...nativeRecord, prerelease: true }
  const result = await new GithubReleaseReader(nativeFixtureRead({ records: [prerelease] }), () => now).get(data())
  expect(result.releases[0]!.kind).toBe('candidate')
})

/** Cold reader with two awaited merges split across consecutive release tags.
 * The latest Changes range deliberately contains only the second merge. */
function cumulativeFixture(prerelease = false) {
  const scene = fixtureScene(); scene.cards = scene.cards.slice(0, 1)
  const card = scene.cards[0]!.source, a = '1'.repeat(40), b = '2'.repeat(40), base = '0'.repeat(40)
  const urls = [1, 2].map(number => `https://github.com/${nativeRepo}/pull/${number}`)
  card.properties.Status!.value = 'Waiting for Prod Release'
  card.properties['GitHub PRs'] = { id: 'prs', type: 'rich_text', hasMore: false, value: urls.join('\n') }
  const data = releaseAssociations(scene)
  data.pulls.forEach((pull, index) => Object.assign(pull, { state: 'merged', freshness: 'fresh', mergeSha: index ? b : a }))
  const tags = [{ name: 'v1.0.1', commit: { sha: b } }, { name: 'v1.0.0', commit: { sha: a } }, { name: 'v0.9.0', commit: { sha: base } }]
  const records = tags.map(tag => ({ ...nativeRecord, tag_name: tag.name, html_url: `https://github.com/${nativeRepo}/releases/tag/${tag.name}`, prerelease: prerelease && tag.name === 'v1.0.0' }))
  let failContainment = false
  const read = vi.fn(async (path: string): Promise<unknown> => {
    if (path.endsWith('/branches/main')) return { commit: { sha: b } }
    if (path.includes('/tags?')) return tags
    if (path.includes('/releases?')) return records
    if (path.includes('/actions/runs?')) return { total_count: 0, workflow_runs: [] }
    if (path.includes('/compare/')) {
      const [from, to] = path.split('/compare/')[1]!.split('?')[0]!.split('...')
      if (failContainment && !path.includes('?')) throw new Error('private failed ancestry read')
      if (from === a && to === b) return { status: 'ahead', merge_base_commit: { sha: a }, total_commits: 1, commits: [{ sha: b }], files: [] }
      if (from === b && to === b) return { status: 'identical', merge_base_commit: { sha: b }, total_commits: 0, commits: [], files: [] }
      if (from === base && to === a) return { status: 'ahead', merge_base_commit: { sha: base }, total_commits: 1, commits: [{ sha: a }], files: [] }
      return { status: 'diverged', merge_base_commit: { sha: base }, total_commits: 1, commits: [], files: [] }
    }
    if (path.includes('/commits/')) {
      const number = path.includes(`/commits/${a}/`) ? 1 : 2, merge = number === 1 ? a : b
      return [{ number, title: `Required change ${number}`, html_url: urls[number - 1], merged_at: nativeTime, merge_commit_sha: merge, head: { sha: merge }, base: { ref: 'main' } }]
    }
    throw new Error(`Unexpected GitHub fixture request: ${path}`)
  })
  const reader = new GithubReleaseReader(read, () => now)
  const releases = { read: async () => {
    const native = await reader.get(data)
    return { ...data, releases: native.releases, releaseSource: { status: native.status, observedAt: native.observedAt, warnings: native.warnings } }
  } }
  return { scene, card, a, b, urls, releases, failContainment: () => { failContainment = true } }
}

it.each([false, true])('resolves cumulative production containment after a cold start (earlier tag prerelease: %s)', async prerelease => {
  const f = cumulativeFixture(prerelease)
  const { DomainReadTools } = await import('../../reconciliation/domainReads')
  const domain = new DomainReadTools({ read: async () => { throw new Error('unused') }, inspect: async () => { throw new Error('unused') } }, f.releases)
  const status = await domain.releaseStatus({ offset: 0, limit: 25 })
  if (status.outcome !== 'available' || !status.releases) throw new Error('Expected release read')
  const latest = status.releases[0]!
  expect(latest.pulls.map(pull => pull.url)).toEqual([f.urls[1]])
  expect(latest.containedPulls).toEqual(f.urls.map((pull, index) => expect.objectContaining({ pull, mergeSha: index ? f.b : f.a, state: 'included' })))
  expect(f.card.properties.Status!.value).toBe('Waiting for Prod Release')
})

it('leaves release waits untouched on server startup and after a minute even when all changes are published', async () => {
  const f = cumulativeFixture()
  const data = await f.releases.read()
  const release = data.releases[0]!
  expect(release.github).toMatchObject({ record: 'available', publishedAt: nativeTime })
  expect(release.containedPulls).toEqual(f.urls.map(pull => expect.objectContaining({ pull, state: 'included' })))

  const root = await mkdtemp(join(tmpdir(), 'release-wait-server-'))
  const events = ['uncaughtException', 'unhandledRejection', 'exit', 'SIGINT', 'SIGTERM'] as const
  const listeners = events.map(event => process.listeners(event))
  const note = vi.fn(async () => {})
  const transition = vi.fn(async () => { f.card.properties.Status!.value = 'Done' })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  vi.stubEnv('TINSTAR_CONFIG_HOME', root)
  vi.spyOn(ReleasesApi.prototype, 'read').mockResolvedValue(data)
  vi.spyOn(ReconciliationSources.prototype, 'scene').mockResolvedValue({ ...f.scene, searchIndex: { documents: [], notes: [] } })
  vi.spyOn(ReconciliationSources.prototype, 'releaseTransport').mockReturnValue({
    card: async () => f.card, hasNote: async () => false, note, transition,
  })
  vi.spyOn(ReconciliationSources.prototype, 'recoverSourceWrites').mockResolvedValue(undefined)
  vi.spyOn(WaitingOnMain.prototype, 'sweep').mockImplementation(async function (this: WaitingOnMain) { return this.view() })
  vi.spyOn(DecisionPreparation.prototype, 'replenish').mockResolvedValue(undefined)
  vi.spyOn(CockpitFleet.prototype, 'start').mockImplementation(() => {})
  vi.spyOn(OtlpExporter.prototype, 'start').mockImplementation(() => {})
  vi.spyOn(QuotaAxiPoller.prototype, 'start').mockImplementation(() => {})
  vi.spyOn(ObservabilityStack.prototype, 'start').mockResolvedValue(undefined)
  vi.spyOn(CodexOtelReceiver.prototype, 'start').mockResolvedValue(undefined)
  vi.spyOn(ReachCoordinator.prototype, 'onListening').mockResolvedValue({ state: 'off' })
  vi.spyOn(bind, 'openListeners').mockResolvedValue([])

  try {
    startServer({ port: 0, host: '127.0.0.1', clientDir: root })
    await setImmediate()
    vi.advanceTimersByTime(60_000)
    await setImmediate()
    expect(transition).not.toHaveBeenCalled()
    expect(note).not.toHaveBeenCalled()
    expect(f.card.properties.Status!.value).toBe('Waiting for Prod Release')
  } finally {
    events.forEach((event, index) => {
      for (const listener of process.listeners(event)) {
        if (!listeners[index]!.includes(listener)) process.removeListener(event, listener)
      }
    })
    vi.useRealTimers()
    resetReachCoordinatorForTests()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps failed containment unknown instead of using the latest Changes range as cumulative proof', async () => {
  const f = cumulativeFixture(); f.failContainment()
  const data = await f.releases.read()
  expect(data.releases![0]!.containedPulls).toEqual(f.urls.map(pull => expect.objectContaining({ pull, state: 'unknown' })))
  expect(JSON.stringify(data)).not.toContain('private failed ancestry read')
})

it('reuses completed commit observations across overlapping ranges for 24 hours', async () => {
  const first = 'c'.repeat(40), second = 'd'.repeat(40), third = 'e'.repeat(40)
  let clock = now
  const read = vi.fn(async (path: string) => {
    if (path.includes('/compare/')) {
      const commits = path.includes(third) ? [first, second, third] : path.includes(second) ? [first, second] : [first]
      return { status: 'ahead', merge_base_commit: { sha: nativeBase }, total_commits: commits.length, commits: commits.map(sha => ({ sha })) }
    }
    return path.includes(first) ? [{ html_url: `https://github.com/${nativeRepo}/pull/123`, merged_at: nativeTime, merge_commit_sha: second }] : []
  })
  const reader = new ReleaseMembershipReader(read, () => clock)
  const baseline = { name: 'v1.0.0', commit: { sha: nativeBase } }
  expect((await reader.since(nativeRepo, first, baseline)).pulls.size).toBe(0)
  clock += 24 * 60 * 60_000 - 1
  expect((await reader.since(nativeRepo, second, baseline)).pulls.size).toBe(1)
  const readsOfFirst = () => read.mock.calls.filter(([path]) => path.includes(`/commits/${first}/pulls`)).length
  expect(readsOfFirst()).toBe(1)
  clock++
  expect((await reader.since(nativeRepo, third, baseline)).pulls.size).toBe(1)
  expect(readsOfFirst()).toBe(2)
})

it.each(['empty', 'open', 'mixed'])('refreshes a %s commit association when a PR later merges', async initial => {
  const first = 'c'.repeat(40), merge = 'd'.repeat(40)
  const pull = { html_url: `https://github.com/${nativeRepo}/pull/123`, merged_at: nativeTime, merge_commit_sha: merge }
  const alreadyMerged = { ...pull, html_url: `https://github.com/${nativeRepo}/pull/124`, merge_commit_sha: first }
  let merged = false
  const read = vi.fn(async (path: string) => {
    if (path.includes('/compare/')) {
      const commits = (merged ? [first, merge] : [first]).map(sha => ({ sha }))
      return { status: 'ahead', merge_base_commit: { sha: nativeBase }, total_commits: commits.length, commits }
    }
    if (!path.includes(`/commits/${first}/pulls`)) return []
    if (merged) return [pull, ...(initial === 'mixed' ? [alreadyMerged] : [])]
    if (initial === 'empty') return []
    const open = { ...pull, merged_at: null }
    return initial === 'mixed' ? [alreadyMerged, open] : [open]
  })
  const reader = new ReleaseMembershipReader(read, () => now)
  const baseline = { name: 'v1.0.0', commit: { sha: nativeBase } }
  const tagged = await reader.get(nativeRepo, first, 'v1.1.0', [baseline])
  expect([...tagged.pulls.values()].map(row => row.number)).toEqual(initial === 'mixed' ? [124] : [])

  merged = true
  const main = await reader.since(nativeRepo, merge, baseline)
  expect(main.membership.status).toBe('complete')
  expect([...main.pulls.values()].map(row => row.number)).toEqual(initial === 'mixed' ? [123, 124] : [123])
})

it('refreshes a merged association first observed outside main', async () => {
  const first = 'c'.repeat(40), merge = 'd'.repeat(40), later = 'e'.repeat(40)
  let onMain = false
  const read = vi.fn(async (path: string) => {
    if (path.includes('/compare/')) {
      const commits = (path.includes(later) ? [first, merge, later] : onMain ? [first, merge] : [first]).map(sha => ({ sha }))
      return { status: 'ahead', merge_base_commit: { sha: nativeBase }, total_commits: commits.length, commits }
    }
    if (!path.includes(`/commits/${first}/pulls`)) return []
    const number = onMain ? 124 : 123
    return [{ html_url: `https://github.com/${nativeRepo}/pull/${number}`, merged_at: nativeTime, merge_commit_sha: onMain ? merge : first }]
  })
  const reader = new ReleaseMembershipReader(read, () => now)
  const baseline = { name: 'v1.0.0', commit: { sha: nativeBase } }
  const tagged = await reader.get(nativeRepo, first, 'v1.1.0', [baseline])
  expect([...tagged.pulls.values()].map(row => row.number)).toEqual([123])

  onMain = true
  for (const head of [merge, later]) {
    const main = await reader.since(nativeRepo, head, baseline)
    expect(main.membership.status).toBe('complete')
    expect([...main.pulls.values()].map(row => row.number)).toEqual([124])
  }
  expect(read.mock.calls.filter(([path]) => path.includes(`/commits/${first}/pulls`))).toHaveLength(2)
})

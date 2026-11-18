import { describe, expect, it, vi } from 'vitest'
import { GithubReleaseReader, nativeReleaseSummary } from '../github'
import { ReleaseMembershipReader } from '../membership'
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
    await reader.get(data()); clock += 61_000; failed = true
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
    tags = [{ name: 'v1.25.0', commit: { sha: 'd'.repeat(40) } }, ...nativeTags]; clock += 61_000
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
  return { scene, card, data, a, b, urls, read, reader, releases, failContainment: () => { failContainment = true } }
}

it.each([false, true])('resolves cumulative production containment after a cold start (earlier tag prerelease: %s)', async prerelease => {
  const f = cumulativeFixture(prerelease)
  const { DomainReadTools } = await import('../../reconciliation/domainReads')
  const { ProductionWaitWriter, productionWaits } = await import('../productionWaits')
  const domain = new DomainReadTools({ read: async () => { throw new Error('unused') }, inspect: async () => { throw new Error('unused') } }, f.releases)
  const status = await domain.releaseStatus({ offset: 0, limit: 25 })
  if (status.outcome !== 'available' || !status.releases) throw new Error('Expected release read')
  const latest = status.releases[0]!
  expect(latest.pulls.map(pull => pull.url)).toEqual([f.urls[1]])
  expect(latest.containedPulls).toEqual(f.urls.map((pull, index) => expect.objectContaining({ pull, mergeSha: index ? f.b : f.a, state: 'included' })))
  const data = await f.releases.read()
  expect(productionWaits(data, f.scene)).toEqual([expect.objectContaining({ requiredPulls: f.urls })])
  const notes: string[] = []
  const transport = { card: async () => f.card, hasNote: async () => false, note: async (_id: string, text: string) => { notes.push(text) }, transition: async (_card: unknown, proposal: { to: string }) => { f.card.properties.Status!.value = proposal.to } }
  expect(await new ProductionWaitWriter(transport, async () => ({ scene: f.scene, data: await f.releases.read() })).run()).toMatchObject({ completed: [f.card.id], unconfirmed: [] })
  expect(f.card.properties.Status!.value).toBe('Done')
  expect(notes[0]).toContain(f.urls[0]); expect(notes[0]).toContain(f.urls[1])
})

it('keeps failed containment unknown instead of using the latest Changes range as cumulative proof', async () => {
  const f = cumulativeFixture(); f.failContainment()
  const { productionWaits } = await import('../productionWaits')
  const data = await f.releases.read()
  expect(data.releases![0]!.containedPulls).toEqual(f.urls.map(pull => expect.objectContaining({ pull, state: 'unknown' })))
  expect(JSON.stringify(data)).not.toContain('private failed ancestry read')
  expect(productionWaits(data, f.scene)).toEqual([])
})

it('revalidates containment for a changed effective merge immediately before a scheduled write', async () => {
  const f = cumulativeFixture()
  const { ProductionWaitWriter } = await import('../productionWaits')
  const transition = vi.fn(async () => {})
  const transport = { card: async () => f.card, hasNote: async () => false,
    note: async () => { f.data.pulls[0]!.mergeSha = 'e'.repeat(40) }, transition }
  await new ProductionWaitWriter(transport, async () => ({ scene: f.scene, data: await f.releases.read() })).run()
  expect(transition).not.toHaveBeenCalled()
  expect(f.card.properties.Status!.value).toBe('Waiting for Prod Release')
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

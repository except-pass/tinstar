import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GithubReleaseReader } from '../github'
import { ReleasesApi } from '../routes'
import { ReleasePullReader } from '../pulls'
import * as acceptance from '../acceptance'
import { releaseAssociations } from '../../../shared/releases'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { nativeFixtureRead, nativeHead, nativeMain, nativeTime, nativeTags, nativeRun } from '../../../../test-fixtures/releases/github-native'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); vi.restoreAllMocks() })
const data = () => releaseAssociations(fixtureScene())
const now = () => Date.parse(nativeTime)

describe('progressive Releases display', () => {
  it.each([false, true])('reports failed association refreshes and clears them after recovery (warm: %s)', async warm => {
    const root = await mkdtemp(join(tmpdir(), 'release-display-failure-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    let clock = Date.parse(nativeTime)
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const scene = { ...fixtureScene(), searchIndex: { documents: [], notes: [] } }
    const source = vi.fn().mockResolvedValue(scene)
    const pulls = new ReleasePullReader()
    vi.spyOn(pulls, 'get').mockResolvedValue(new Map())
    const reader = new GithubReleaseReader(nativeFixtureRead(), now)
    await reader.get(data())
    const api = new ReleasesApi({ scene: source }, root, pulls, undefined, reader)
    const retained = warm ? await api.read() : null
    source.mockRejectedValue(new Error('private upstream credentials'))
    api.display()
    await vi.waitFor(() => expect(api.display().warnings.join(' ')).toContain('refresh failed'))
    const failed = api.display()
    expect(failed.associationsComplete).toBe(false)
    expect(failed.pulls).toEqual(retained?.pulls ?? [])
    expect(failed.warnings.join(' ')).toContain('last known')
    expect(failed.warnings.join(' ')).not.toContain('still loading')
    expect(JSON.stringify(failed)).not.toContain('private upstream credentials')
    expect(failed.releases!.every(release => release.gaps.some(gap => gap.includes('refresh failed')))).toBe(true)
    source.mockResolvedValue(scene)
    clock += 20_001
    api.display()
    await vi.waitFor(() => expect(api.display().warnings.join(' ')).not.toContain('refresh failed'))
    expect(api.display().associationsComplete).toBe(releaseAssociations(scene).associationsComplete)
    expect(api.display().releases!.every(release => release.gaps.every(gap => !gap.includes('refresh failed')))).toBe(true)
  })

  it('retains acceptance receipt warnings when native releases overlay the enriched read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-display-acceptance-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    vi.spyOn(acceptance, 'readAcceptanceRecords').mockRejectedValue(new Error('unreadable'))
    const pulls = new ReleasePullReader()
    vi.spyOn(pulls, 'get').mockResolvedValue(new Map())
    const reader = new GithubReleaseReader(nativeFixtureRead(), now)
    const api = new ReleasesApi({ scene: async () => ({ ...fixtureScene(), searchIndex: { documents: [], notes: [] } }) }, root, pulls, undefined, reader)
    const enriched = await api.read()
    const warning = enriched.warnings.find(message => message.startsWith('Acceptance receipt store'))!
    expect(warning).toBeTruthy()
    const displayed = api.display()
    expect(displayed.releases!.length).toBeGreaterThan(0)
    for (const release of displayed.releases!) expect(release.gaps).toContain(warning)
  })

  it.each([
    { runs: [nativeRun], state: 'Awaiting PROD verification' },
    { runs: [{ ...nativeRun, status: 'in_progress', conclusion: null }], state: 'Running' },
    { runs: [{ ...nativeRun, conclusion: 'failure' }], state: 'Failed/unfinished components' },
    { runs: [], state: 'Deployment unknown' },
  ])('expires cached Actions during a blocked catalog refresh and recovers $state', async ({ runs, state }) => {
    let clock = now(), blocked = false, finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const fixture = nativeFixtureRead({ runs })
    const reader = new GithubReleaseReader(async path => {
      if (blocked && path.includes('/tags?')) await gate
      return fixture(path)
    }, () => clock)
    const initial = await reader.get(data())
    expect(initial.status).toBe('fresh')
    expect(initial.releases[0]).toMatchObject({ state, provenance: { historical: false }, github: { runsStatus: 'fresh' } })
    const retainedRuns = initial.releases[0]!.github!.runs
    clock += 60_000; blocked = true
    try {
      const expired = reader.display(data())
      expect(expired).toMatchObject({ refreshing: true, status: 'partial' })
      expect(expired.releases[0]).toMatchObject({ state: 'Unknown', provenance: { historical: true }, github: { runsStatus: 'unknown', runs: retainedRuns } })
      expect(expired.releases[0]!.provenance.asOf).toBe(initial.releases[0]!.provenance.asOf)
      expect(expired.releases[0]!.gaps).toContain('Actions evidence is pending, stale or unreadable; retained runs are last known.')
      clock += 120_000
      const stillBlocked = reader.display(data())
      expect(stillBlocked).toMatchObject({ refreshing: true, status: 'partial' })
      expect(stillBlocked.releases[0]!.github!.runsStatus).toBe('unknown')
      expect(initial.releases[0]!.github!.runsStatus).toBe('fresh')
    } finally { blocked = false; finish() }
    const recovered = await reader.get(data())
    expect(recovered.status).toBe('fresh')
    expect(recovered.releases[0]).toMatchObject({ state, provenance: { historical: false }, github: { runsStatus: 'fresh', runs: retainedRuns } })
    expect(recovered.releases[0]!.gaps).not.toContain('Actions evidence is pending, stale or unreadable; retained runs are last known.')
    expect(reader.display(data()).releases[0]!.github!.runsStatus).toBe('fresh')
  })

  it('publishes tagged identities immediately while slow Actions reads remain pending', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve }), fixture = nativeFixtureRead()
    const reader = new GithubReleaseReader(async path => { if (path.includes('/actions/runs?')) await gate; return fixture(path) }, now)
    expect(reader.display(data()).refreshing).toBe(true)
    await vi.waitFor(() => {
      const display = reader.display(data())
      expect(display.releases.filter(release => release.kind === 'production').map(release => release.version)).toEqual(['v1.24.0', 'v1.22.0'])
      expect(display.releases.filter(release => release.kind === 'draft').map(release => release.version)).toEqual(['main'])
      expect(display.refreshing).toBe(true)
    })
    finish(); await reader.get(data())
  })

  it('serves the warm HTTP catalog under three seconds while Notion associations are blocked', async () => {
    const reader = new GithubReleaseReader(nativeFixtureRead(), now)
    await reader.get(data())
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const root = await mkdtemp(join(tmpdir(), 'release-display-'))
    const api = new ReleasesApi({ scene: async () => { await gate; return { ...fixtureScene(), searchIndex: { documents: [], notes: [] } } } }, root, undefined, undefined, reader)
    const server = createServer((req, res) => { void api.handle(req, res) })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    cleanups.push(async () => { finish(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
    const start = performance.now()
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/releases`)
    const body = await response.json()
    expect(performance.now() - start).toBeLessThan(3000)
    expect(body.data.refreshing).toBe(true)
    expect(body.data.associationsComplete).toBe(false)
    expect(body.data.releases[0]).toMatchObject({ version: 'v1.24.0', sourceSha: nativeHead, kind: 'production', github: { runs: [expect.objectContaining({ name: 'RA Command' })] } })
    expect(body.data.releases.find((release: { kind: string }) => release.kind === 'draft')).toMatchObject({ version: 'main', sourceSha: nativeMain, membership: { baseline: 'v1.24.0' } })
  })

  it('lists every tag in numeric order and enriches an older selection on demand', async () => {
    const names = ['v1.15.0', 'v1.9.0', 'v1.24.0', 'v1.18.0', 'v1.21.0', 'v1.22.0', 'v1.20.0']
    const tags = names.map((name, index) => ({ name, commit: { sha: index.toString(16).repeat(40) } }))
    const fixture = nativeFixtureRead({ tags })
    const read = vi.fn(async (path: string) => {
      if (path.includes('/compare/')) {
        const [base, head] = path.split('/compare/')[1]!.split('?')[0]!.split('...')
        return { status: 'ahead', total_commits: 1, merge_base_commit: { sha: base }, commits: [{ sha: head }], files: [{ filename: 'older-release.ts' }] }
      }
      return fixture(path)
    })
    const reader = new GithubReleaseReader(read, now)
    const result = await reader.get(data())
    expect(result.releases.filter(release => release.kind === 'production').map(release => release.version)).toEqual(['v1.24.0', 'v1.22.0', 'v1.21.0', 'v1.20.0', 'v1.18.0', 'v1.15.0', 'v1.9.0'])
    const older = result.releases.find(release => release.version === 'v1.15.0')!
    expect(older.github!.runsStatus).toBe('unknown')
    expect(older.membership.status).toBe('pending')
    const olderSha = tags.find(tag => tag.name === older.version)!.commit.sha
    expect(read.mock.calls.filter(([path]) => path.includes('/actions/runs?'))).toHaveLength(5)
    expect(read.mock.calls.some(([path]) => path.includes(`/actions/runs?head_sha=${olderSha}`))).toBe(false)
    read.mockClear()
    const selected = (await reader.get(data(), older.version)).releases.find(release => release.id === older.id)!
    expect(selected).toMatchObject({ scope: ['older-release.ts'], github: { runsStatus: 'fresh' }, membership: { status: 'complete', baseline: 'v1.9.0' } })
    expect(read.mock.calls.filter(([path]) => path.includes('/actions/runs?'))).toHaveLength(1)
    expect(read.mock.calls.some(([path]) => path.includes(`/actions/runs?head_sha=${olderSha}`))).toBe(true)
  })

  it.each([nativeHead, 'e'.repeat(40)])('invalidates Plan when a new baseline tag points to %s behind unchanged main', async baselineSha => {
    let clock = now(), tags = [...nativeTags], finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const fixture = nativeFixtureRead()
    let changed = false, comparing = false
    const reader = new GithubReleaseReader(async path => {
      if (path.includes('/tags?')) return tags
      if (changed && path.includes(`/compare/${baselineSha}...${nativeMain}`)) {
        comparing = true
        await gate
        return { status: 'ahead', total_commits: 0, merge_base_commit: { sha: baselineSha }, commits: [], files: [] }
      }
      return fixture(path)
    }, () => clock)
    const initial = (await reader.get(data())).releases.find(release => release.kind === 'draft')!
    expect(initial.membership.status).toBe('complete')
    expect(initial.pulls.map(pull => pull.number)).toEqual([3401])
    tags = [{ name: 'v1.25.0', commit: { sha: baselineSha } }, ...tags]
    changed = true; clock += 61_000
    const refreshing = reader.get(data())
    try {
      await vi.waitFor(() => expect(comparing).toBe(true))
      const pending = reader.display(data()).releases.find(release => release.kind === 'draft')!
      expect(pending).toMatchObject({ sourceSha: nativeMain, scope: [], pulls: [], membership: { status: 'pending', baseline: 'v1.25.0', baselineSha } })
    } finally { finish() }
    const updated = (await refreshing).releases.find(release => release.kind === 'draft')!
    expect(updated).toMatchObject({ scope: [], pulls: [], membership: { status: 'complete', baseline: 'v1.25.0', baselineSha } })
  })

  it('puts tagged versions in history even with no runs, and derives Plan only from the latest-tag to main comparison', async () => {
    const read = vi.fn(nativeFixtureRead({ runs: [] }))
    const result = await new GithubReleaseReader(read, now).get(data())
    expect(result.releases.filter(release => release.kind === 'production').map(release => release.version)).toEqual(['v1.24.0', 'v1.22.0'])
    const plan = result.releases.filter(release => release.kind === 'draft')
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ version: 'main', scope: ['components/ra-command/next.ts'], membership: { baseline: 'v1.24.0', status: 'complete' } })
    expect(plan[0]!.pulls.map(pull => pull.number)).toEqual([3401])
    expect(plan[0]!.pulls.map(pull => pull.number)).not.toContain(3267)
    expect(read.mock.calls.some(([path]) => path.includes(`/compare/${nativeHead}...${nativeMain}`))).toBe(true)
  })

  it('reads paginated SHA-matching runs through the existing Reader query and filters tag/event locally', async () => {
    const fixture = nativeFixtureRead()
    const read = vi.fn(async (path: string) => {
      const url = new URL(path, 'https://api.github.com')
      if (url.pathname.endsWith('/actions/runs') && url.searchParams.has('event')) throw new Error('Old broker does not allow the event query')
      return fixture(path)
    })
    const result = await new GithubReleaseReader(read, now).get(data())
    expect(result.releases[0]!.github!.runs).toHaveLength(1)
    expect(result.releases[0]!.github!.runs[0]).toMatchObject({ name: 'RA Command', sha: nativeHead })
  })
})

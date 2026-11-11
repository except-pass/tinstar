import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GithubReleaseReader } from '../github'
import { ReleasesApi } from '../routes'
import { releaseAssociations } from '../../../shared/releases'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { nativeFixtureRead, nativeHead, nativeMain, nativeTime } from '../../../../test-fixtures/releases/github-native'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())) })
const data = () => releaseAssociations(fixtureScene())
const now = () => Date.parse(nativeTime)

describe('progressive Releases display', () => {
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

  it('sorts numeric version parts newest-first and bounds the default history to five tags', async () => {
    const names = ['v1.15.0', 'v1.9.0', 'v1.24.0', 'v1.18.0', 'v1.21.0', 'v1.22.0', 'v1.20.0']
    const tags = names.map((name, index) => ({ name, commit: { sha: index.toString(16).repeat(40) } }))
    const read = nativeFixtureRead({ tags })
    const result = await new GithubReleaseReader(read, now).get(data())
    expect(result.releases.filter(release => release.kind === 'production').map(release => release.version)).toEqual(['v1.24.0', 'v1.22.0', 'v1.21.0', 'v1.20.0', 'v1.18.0'])
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

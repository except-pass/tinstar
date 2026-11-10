import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'
import { ReleasesApi } from '../routes'
import { acceptanceFixture } from '../../../../test-fixtures/releases/acceptance'
import { ReleaseAcceptanceRunner, readAcceptanceRecords } from '../acceptance'
import { ReleaseObjectReader } from '../objects'
import { releaseChanges } from '../../../shared/releaseChanges'
import { ReleasePullReader } from '../pulls'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); resetOriginAllowlistForTests(); vi.restoreAllMocks() })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'releases-api-')), scene = { ...fixtureScene(), searchIndex: { documents: [], notes: [] } }
  const read = vi.fn().mockResolvedValue({ title: 'Real merged PR', state: 'closed', merged: true, merged_at: '2026-11-06T18:00:00Z', merge_commit_sha: 'a'.repeat(40) })
  const api = new ReleasesApi({ scene: async () => scene }, root, new ReleasePullReader(read), async () => ['owner@example.com'])
  const server = createServer((req, res) => { void api.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end() } }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  seedOriginAllowlist(port)
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${port}`
  const payload = { id: randomUUID(), pull: 'https://github.com/owner/repo/pull/12', cardId: scene.cards[0]!.id, action: 'link', reason: 'Reviewed explicit requirement' }
  return { api, scene, read, payload, base, root }
}
const headers = { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1', 'Tailscale-User-Login': 'owner@example.com' }
describe('Releases HTTP boundary', () => {
  it('omits acceptance audits outside visible checks without changing persisted history', async () => {
    const { root, scene, base } = await setup()
    const fixture = acceptanceFixture('human')
    fixture.pull.links = fixture.pull.links.slice(0, 1)
    Object.assign(scene, fixture.scene)
    vi.spyOn(ReleaseObjectReader.prototype, 'get').mockResolvedValue([fixture.release])
    const github = vi.fn()
    const runner = new ReleaseAcceptanceRunner(root, async () => ({ data: fixture.data, scene }), github)
    const key = releaseChanges(fixture.release, fixture.data, scene)[0]!.checks![0]!.key
    await runner.perform({ actor: 'reviewer', key, action: 'manual', reason: 'Observed exact assertion', outcome: 'passed', evidence: 'https://example.com/manual-proof' })
    const history = await readAcceptanceRecords(root)
    const visible = await (await fetch(`${base}/api/releases`)).json()
    expect(visible.data.acceptanceRecords).toEqual(history)
    scene.cards = scene.cards.filter(card => card.id !== fixture.pull.links[0]!.cardId)
    const removed = await (await fetch(`${base}/api/releases`)).json()
    expect(removed.data.acceptanceRecords).toEqual([])
    expect(await readAcceptanceRecords(root)).toEqual(history)
    expect(github).not.toHaveBeenCalled()
  })
  it('requests history so a PR linked only to Done work remains visible', async () => {
    const { root, scene, read } = await setup()
    const card = scene.cards[0]!
    card.source.properties.Status!.value = 'Done'
    card.source.properties.Link = { id: 'link', type: 'url', value: 'https://github.com/owner/repo/pull/999', hasMore: false }
    const sources = { scene: async (_force = false, scope: { history?: boolean } = {}) => ({ ...scene, cards: scope.history ? [card] : [] }) }
    const historyApi = new ReleasesApi(sources, root, new ReleasePullReader(read))
    const data = await historyApi.read()
    expect(data.pulls.map(pull => pull.number)).toContain(999)
  })
  it('allows the UI handshake in desktop preflight without bypassing owner authorization', async () => {
    const { base, payload } = await setup()
    const Origin = 'https://tauri.localhost'
    const preflight = await fetch(`${base}/api/releases/associations`, { method: 'OPTIONS', headers: {
      Origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type,x-tinstar-ui',
    } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe(Origin)
    expect(preflight.headers.get('access-control-allow-headers')?.toLowerCase().split(/,\s*/)).toEqual(expect.arrayContaining(['content-type', 'x-tinstar-ui']))
    expect((await fetch(`${base}/api/releases/associations`, { method: 'POST', headers: { ...headers, Origin }, body: JSON.stringify(payload) })).status).toBe(200)
    expect((await fetch(`${base}/api/releases/associations`, { method: 'POST', headers: { ...headers, Origin, 'Tailscale-User-Login': 'other@example.com' }, body: JSON.stringify(payload) })).status).toBe(403)
  })
  it('keeps an unreadable empty local audit incomplete at collection level', async () => {
    const { base, api, scene } = await setup()
    scene.cards = []
    vi.spyOn(api.store, 'read').mockRejectedValue(new Error('Unreadable audit'))
    const { data } = await (await fetch(`${base}/api/releases`, { headers })).json()
    expect(data.pulls).toEqual([])
    expect(data.associationsComplete).toBe(false)
    expect(data.associationsWritable).toBe(false)
    expect(data.warnings).toContain('Local association audit unavailable; manual associations cannot be verified')
  })
  it('allows read-only collection and owner local link/unlink without Notion or GitHub mutation', async () => {
    const { base, payload, api, read } = await setup()
    const before = await (await fetch(`${base}/api/releases`)).json()
    expect(before.data.associationsWritable).toBe(false)
    const post = () => fetch(`${base}/api/releases/associations`, { method: 'POST', headers, body: JSON.stringify(payload) })
    expect((await post()).status).toBe(200)
    expect((await post()).status).toBe(200)
    expect(await api.store.read()).toHaveLength(1)
    const linked = await (await fetch(`${base}/api/releases`, { headers })).json()
    expect(linked.data.pulls[0]).toMatchObject({ id: 'owner/repo#12', state: 'merged', mergeSha: 'a'.repeat(40) })
    expect(read).toHaveBeenCalledTimes(1)
    const unlink = await fetch(`${base}/api/releases/associations`, { method: 'POST', headers, body: JSON.stringify({ ...payload, id: randomUUID(), action: 'unlink' }) })
    expect(unlink.status).toBe(200)
    const after = await (await fetch(`${base}/api/releases`)).json()
    expect(after.data.pulls[0].links[0].active).toBe(false)
    expect(after.data.pulls[0].exceptions).toContain('No linked Notion card')
  })
  it('rejects cross-origin or unauthenticated writes and inaccessible card IDs', async () => {
    const { base, payload, api } = await setup()
    for (const requestHeaders of [{ 'Content-Type': 'application/json' }, { ...headers, Origin: 'https://evil.invalid' }, { ...headers, 'Tailscale-User-Login': 'other@example.com' }, { ...headers, 'X-Tinstar-UI': '' }]) {
      expect((await fetch(`${base}/api/releases/associations`, { method: 'POST', headers: requestHeaders, body: JSON.stringify(payload) })).status).toBe(403)
    }
    expect((await fetch(`${base}/api/releases/associations`, { method: 'POST', headers, body: JSON.stringify({ ...payload, cardId: 'f'.repeat(32) }) })).status).toBe(404)
    expect(await api.store.read()).toEqual([])
    expect((await fetch(`${base}/api/releases`, { headers: { Origin: 'https://evil.invalid' } })).status).toBe(403)
  })
  it('publishes GitHub failures in sync state and offers a GET-only dry-run report without domain writes', async () => {
    const { base, scene, read, api } = await setup()
    scene.cards[0]!.source.properties.Link = { id: 'link', type: 'url', value: 'https://github.com/owner/repo/pull/1', hasMore: false }
    scene.cards[0]!.source.properties.Status!.value = 'Waiting for Prod Release'
    read.mockRejectedValue(Object.assign(new Error('private stderr'), { code: 'ENOENT' }))
    const result = await (await fetch(`${base}/api/releases`)).json()
    expect(result.data.githubSync).toMatchObject({ status: 'error', errors: [expect.stringContaining('gh-axi is unavailable')] })
    expect(result.data.reconciliation).toMatchObject({ mode: 'dry-run', sourceStatus: 'unconfigured' })
    expect(JSON.stringify(result)).not.toContain('private stderr')
    const report = await (await fetch(`${base}/api/releases/reconciliation`)).json()
    expect(report.data.mode).toBe('dry-run')
    expect((await fetch(`${base}/api/releases/reconciliation`, { method: 'POST', headers, body: '{}' })).status).toBe(400)
    expect(await api.store.read()).toEqual([])
  })

})

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
import { ReleasePullReader } from '../pulls'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); resetOriginAllowlistForTests() })
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
  return { api, scene, read, payload, base }
}
const headers = { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1', 'Tailscale-User-Login': 'owner@example.com' }
describe('Releases HTTP boundary', () => {
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
})

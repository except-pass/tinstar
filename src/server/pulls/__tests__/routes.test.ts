import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { PullsApi } from '../routes'
import { PullReader } from '../reader'
import { AssociationStore } from '../../releases/associations'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); resetOriginAllowlistForTests() })
it('reuses the shared audit for many-to-many links, keeps unlinked PRs, and refuses mutations/cross-origin reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr-ops-'))
  await writeFile(join(root, 'config.json'), JSON.stringify({ prOperations: { repositories: ['owner/repo'] }, ask: { ownerLogins: ['owner@example.test'], bridgeToken: 'x'.repeat(32) } }))
  const scene = { ...fixtureScene(), searchIndex: { documents: [], notes: [] } }, store = new AssociationStore(root)
  const cardIds = scene.cards.slice(0, 2).map(card => card.id)
  for (const cardId of cardIds) await store.append({ id: randomUUID(), pull: 'https://github.com/owner/repo/pull/1', cardId, action: 'link', reason: 'Explicit approved relationship' }, 'owner')
  const read = vi.fn().mockResolvedValue([1, 2].map(number => ({ number, title: `PR ${number}`, html_url: `https://github.com/owner/repo/pull/${number}`, user: { login: 'author' }, draft: false, head: { sha: 'a'.repeat(40) }, base: { ref: 'main' }, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' })))
  const api = new PullsApi({ scene: async () => scene }, store, root, new PullReader(read))
  const server = createServer((req, res) => { void api.handle(req, res) }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  seedOriginAllowlist((server.address() as { port: number }).port)
  const headers = { 'Tailscale-User-Login': 'owner@example.test' }
  for (const path of ['/api/pulls', `/api/pulls/detail?url=https://github.com/owner/repo/pull/1&head=${'a'.repeat(40)}`]) {
    for (const denied of [{}, { 'Tailscale-User-Login': 'stranger@example.test' }] as Record<string, string>[]) {
      const response = await fetch(`${base}${path}`, { headers: denied })
      expect(response.status).toBe(403)
      expect((await response.json()).error.message).toContain('Authorized tailnet owner required')
    }
  }
  expect(read).not.toHaveBeenCalled()
  const detail = vi.spyOn(PullReader.prototype, 'detail').mockResolvedValue({ body: 'Private description', reviews: [{ author: 'private-reviewer' }] } as never)
  const detailBody = await (await fetch(`${base}/api/pulls/detail?url=https://github.com/owner/repo/pull/1&head=${'a'.repeat(40)}`, { headers })).json()
  expect(detailBody.data.body).toBe('Private description')
  expect(detailBody.data.reviews[0].author).toBe('private-reviewer')
  detail.mockRestore()
  const body = await (await fetch(`${base}/api/pulls`, { headers })).json()
  expect(body.ok).toBe(true)
  expect(body.data.pulls).toHaveLength(2)
  expect(body.data.pulls[0].links.filter((link: { active: boolean }) => link.active)).toHaveLength(2)
  expect(body.data.pulls[1].links).toEqual([])
  expect((await fetch(`${base}/api/pulls`, { method: 'POST', headers })).status).toBe(400)
  expect((await fetch(`${base}/api/pulls`, { headers: { Origin: 'https://evil.invalid' } })).status).toBe(403)
  expect((await fetch(`${base}/api/pulls/detail?url=https://github.com/other/repo/pull/1&head=${'a'.repeat(40)}`, { headers })).status).toBe(400)
  expect(await store.read()).toHaveLength(2)
  expect(read).toHaveBeenCalledTimes(1)
})

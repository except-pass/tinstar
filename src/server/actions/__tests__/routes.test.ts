import { afterEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { ActionsApi } from '../routes'
import { ActionStore } from '../store'
import { actionExamples } from '../examples'
import { readActionSnapshot, readActionJob } from '../evidence'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'
import { artifactContext } from '../../ask/artifacts'
import { snapshot, head, baseHead } from './fixtures'
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); resetOriginAllowlistForTests() })
it('authenticates every local operation, rejects cross-origin/live routes, installs owner grants and exposes durable receipts to Ask', async () => {
  const root = await mkdtemp(join(tmpdir(), 'actions-api-'))
  await writeFile(join(root, 'config.json'), JSON.stringify({ ask: { ownerLogins: ['owner@example.test'] } }))
  const read = vi.fn(async () => snapshot())
  const api = new ActionsApi(new ActionStore(join(root, 'actions')), read, root)
  const server = createServer((req, res) => { void api.handle(req, res) }); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }) })
  const port = (server.address() as { port: number }).port, base = `http://127.0.0.1:${port}`; seedOriginAllowlist(port)
  const headers = { 'Tailscale-User-Login': 'owner@example.test', 'X-Tinstar-UI': '1', 'Content-Type': 'application/json' }
  const post = (path: string, data: unknown, auth: Record<string, string> = headers) => fetch(base + path, { method: 'POST', headers: auth, body: JSON.stringify(data) })
  for (const auth of [{}, { ...headers, 'Tailscale-User-Login': 'stranger' }, { ...headers, 'X-Tinstar-UI': '' }, { ...headers, Origin: 'https://evil.example.test' }]) expect((await post('/api/actions/install', {}, auth)).status).toBe(403)
  expect(read).not.toHaveBeenCalled()
  const candidate = actionExamples().find(row => row.manifest.id === 'explain')!
  const saved = await (await post('/api/actions/install', { candidate, inspected: true })).json()
  expect(saved.data.grant.actor).toBe('owner@example.test')
  expect((await post('/api/actions/install', { candidate: { ...candidate, grant: { actor: 'forged' } }, inspected: true })).status).toBe(400)
  const input = { key: randomUUID(), action: 'explain', version: 'v1', targets: [{ url: snapshot().url, head, base: 'main' }], mode: 'direct', view: { scene: 'pulls' } }
  const started = await (await post('/api/actions/run', input)).json(); expect(started.data.actualGitHubWrites).toBe(0)
  await api.executor.wait(started.data.runId)
  const receipt = (await api.store.receipts())[0]!
  const context = await artifactContext({ kind: 'pull', id: snapshot().id, head, action_receipt_id: receipt.id }, { scene: 'pulls' }, { field_key: 'receipt' }, {
    pulls: async () => ({ pulls: [{ ...snapshot(), title: 'Real PR', author: 'owner', createdAt: '', updatedAt: '', freshness: 'fresh', links: [] }], repositories: [], warnings: [], associationsComplete: true }), releases: async () => ({ pulls: [] } as never), actionReceipt: id => api.receipt(id),
  })
  expect(context.action_receipt).toMatchObject({ id: receipt.id, actual_github_writes: 0, outcome: 'simulated' })
  expect(context.return_to?.target).toMatchObject({ kind: 'pull', action_receipt_id: receipt.id })
  expect((await post('/api/actions/live-merge', {})).status).toBe(404)
  expect((await post('/api/actions/run', { ...input, key: randomUUID(), targets: [{ ...input.targets[0], url: 'https://github.com/kunchenguid/firstmate/pull/1' }] })).status).toBe(409)
  expect((await post('/api/actions/run', { ...input, key: randomUUID(), targets: [{ ...input.targets[0], head: baseHead }] })).status).toBe(409)
})
it('GET snapshot rechecks head/base, refuses mixed pagination, and preserves unknown thread/rule/check evidence', async () => {
  const metadata = { number: 1, html_url: snapshot().url, state: 'open', merged: false, draft: false, mergeable: true, changed_files: 1, head: { sha: head, ref: 'feature', repo: { full_name: 'fortresspower/cmsandbox' } }, base: { sha: baseHead, ref: 'main' } }
  const read = vi.fn(async (path: string): Promise<unknown> => path.includes('/files?') ? [{ filename: 'src/a.ts' }] : path.includes('check-runs?') ? { total_count: 0, check_runs: [] } : path.endsWith('/status') ? { total_count: 0 } : path.includes('/branches/') ? { protected: false } : metadata)
  const result = await readActionSnapshot(snapshot().url, read)
  expect(result).toMatchObject({ head, baseHead, threadsResolved: null, rulesVerified: false, protectedHead: false, pathsComplete: true })
  expect(read.mock.calls.every(([path]) => path.startsWith('/repos/fortresspower/cmsandbox/'))).toBe(true)
  let count = 0
  const drifting = async (path: string) => path.endsWith('/pulls/1') ? { ...metadata, head: { ...metadata.head, sha: ++count === 1 ? head : baseHead } } : read(path)
  await expect(readActionSnapshot(snapshot().url, drifting)).rejects.toThrow('changed while reading')
  const job = await readActionJob('fortresspower/cmsandbox', 12, async path => path.endsWith('/jobs/12') ? { id: 12, run_id: 34, status: 'completed', conclusion: 'failure' } : { id: 34, head_sha: head, run_attempt: 1, repository: { full_name: 'fortresspower/cmsandbox' } })
  expect(job).toMatchObject({ id: 12, runId: 34, head, dependentJobs: null })
})

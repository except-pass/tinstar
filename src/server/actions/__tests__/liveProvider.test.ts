import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync, verify } from 'node:crypto'
import { LiveProvider, brokerConfigSchema, readerScope, type ProviderRequest, type ProviderTransport } from '../liveProvider'
import { assertBrokerIdentity, listenBroker } from '../brokerService'
import { ActionExecutor } from '../executor'
import { ActionStore } from '../store'
import { head, snapshot, installed, policy, run, merge } from './fixtures'
import { readerRepositories, type ActionOperation } from '../../../shared/actions'
import { brokerData, brokerRequest } from '../liveClient'
import { githubJson } from '../../pulls/github'
import { PullReader } from '../../pulls/reader'
import { sourceDigest } from '../examples'
import { stageTestRuntime } from './runtimeFixture'

const roots: string[] = []
const secret = 'fake-installation-secret-with-no-format-assumption'
let privateKey: string, publicKey: string
beforeAll(() => { ({ privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })) }, 30_000)
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup(options: { credentials?: boolean; enabled?: boolean; response?: (input: ProviderRequest) => Promise<unknown> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'tinstar-live-provider-')); roots.push(root)
  const custody = join(root, 'credentials'); await mkdir(custody, { mode: 0o700 })
  if (options.credentials !== false) for (const profile of ['reader', 'repair']) await writeFile(join(custody, `${profile}.pem`), privateKey, { mode: 0o600 })
  const repositories = Object.fromEntries(readerRepositories.map((repository, i) => [repository, i + 1]))
  const config = brokerConfigSchema.parse({ webUid: 12345, ownerLogins: ['owner'], reviewAuthor: 'except-pass', custody, actions: join(root, 'actions'), socket: join(root, 'broker.sock'), runtime: '/not-provisioned',
    reader: { appId: 10, installations: [{ installationId: 20, repositories }] }, repair: { appId: 11, installations: [{ installationId: 21, repositories: { 'fortresspower/cmsandbox': repositories['fortresspower/cmsandbox'] } }] } })
  const requests: ProviderRequest[] = []
  const transport: ProviderTransport = async input => {
    requests.push(input)
    if (input.path.endsWith('/access_tokens')) {
      const payload = input.body as { repository_ids: number[]; permissions: Record<string, string> }
      const [header, body, signature] = input.authorization.split('.')
      expect(verify('RSA-SHA256', Buffer.from(`${header}.${body}`), publicKey, Buffer.from(signature!, 'base64url'))).toBe(true)
      return { status: 201, data: { token: secret, expires_at: new Date(Date.now() + 55 * 60_000).toISOString(), permissions: payload.permissions,
        repositories: payload.repository_ids.map(id => ({ id, full_name: Object.entries(repositories).find(([, value]) => value === id)![0] })) } }
    }
    if (input.method !== 'GET') return { status: input.method === 'PUT' ? 202 : 201, data: null }
    const custom = options.response && await options.response(input)
    if (custom !== undefined) return { status: 200, data: custom }
    const repository = input.path.match(/^\/repos\/([^/]+\/[^/?]+)/)?.[1]!
    if (input.path === `/repos/${repository}`) return { status: 200, data: { id: repositories[repository], full_name: repository, owner: { login: repository.split('/')[0] } } }
    if (/\/pulls\/\d+$/.test(input.path)) return { status: 200, data: { number: 1, html_url: snapshot().url, state: 'open', merged: false, draft: false, mergeable: true, changed_files: 1,
      head: { sha: head, ref: 'feature-1', repo: { full_name: repository } }, base: { sha: snapshot().baseHead, ref: 'main' } } }
    if (input.path.includes('/files?')) return { status: 200, data: [{ filename: 'components/web-fmp/src/example.ts' }] }
    if (input.path.includes('/check-runs?')) return { status: 200, data: { total_count: 0, check_runs: [] } }
    if (input.path.endsWith('/status')) return { status: 200, data: { total_count: 0 } }
    if (input.path.includes('/branches/')) return { status: 200, data: { protected: false } }
    if (input.path.endsWith('/actions/jobs/123')) return { status: 200, data: { id: 123, run_id: 456, name: 'test', status: 'completed', conclusion: 'failure' } }
    if (input.path.endsWith('/actions/runs/456')) return { status: 200, data: { id: 456, head_sha: head, head_branch: 'feature-1', run_attempt: 1, event: 'push', path: '.github/workflows/ci.yml', repository: { full_name: repository } } }
    if (input.path.includes('/contents/')) return { status: 200, data: { encoding: 'base64', content: Buffer.from('on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: []\n').toString('base64') } }
    return { status: 200, data: [] }
  }
  return { root, custody, config, requests, transport, provider: new LiveProvider(config, transport, options.enabled ?? true) }
}
// Token minting is RSA-2048, and the socket test also starts bubblewrap.
// 30s is wall-clock room for that work while the rest of the suite is running.
describe('live provider under suite load', () => {
const update: ActionOperation = { kind: 'repair.update', expectedHead: head, ref: 'refs/heads/feature-1' }
const rerun: ActionOperation = { kind: 'repair.rerun', expectedHead: head, jobId: 123, runId: 456, attempt: 1 }

it('mints only explicit repository IDs and minimal endpoint permissions; keeps JWT, key and token inside custody', async () => {
  const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubEnv('GH_TOKEN', 'ambient-token-must-not-be-used')
  const fixture = await setup({ response: async input => input.path.includes('/reviews?') ? [{ body: `reflected ${secret}` }] : undefined })
  const output = await fixture.provider.read('/repos/fortresspower/cmsandbox/pulls/1/reviews?per_page=100')
  expect(output).toEqual([{ body: 'reflected [redacted]' }])
  expect(fixture.requests[0]?.body).toEqual({ repository_ids: [5], permissions: { metadata: 'read', pull_requests: 'read' } })
  expect(fixture.requests[1]?.authorization).toBe(secret)
  const externallyVisible = JSON.stringify([output, fixture.provider, logged.mock.calls, process.env])
  for (const value of [secret, privateKey, fixture.requests[0]!.authorization]) expect(externallyVisible).not.toContain(value)
  expect(fixture.requests.every(request => request.authorization !== process.env.GH_TOKEN)).toBe(true)
})
it('uses verified installation identity, separately from review author, on exactly ten repositories', async () => {
  const fixture = await setup()
  expect(await fixture.provider.identity()).toEqual({ account: 'except-pass', owners: ['except-pass', 'fortresspower'], repositories: [...readerRepositories], authenticatedActor: 'Tin Star Reader App', credentialProfile: 'Reader' })
  expect(fixture.requests.some(request => request.path === '/user' || request.path === '/user/orgs')).toBe(false)
})
it.each(['/repos/kunchenguid/firstmate/pulls', '/repos/fortresspower/other/pulls', '/user', '/repos/fortresspower/cmsandbox/pulls/1/merge',
  '/repos/fortresspower/cmsandbox/compare/main...release', '/repos/fortresspower/cmsandbox/commits/main',
  '/repos/fortresspower/cmsandbox/git/refs/heads/main', '/repos/fortresspower/cmsandbox/actions/runs/1/rerun', '/repos/fortresspower/cmsandbox/pulls?permissions=write',
  '/repos/fortresspower/cmsandbox/../cmsandbox/pulls', '//attacker.test/repos/fortresspower/cmsandbox/pulls'])('denies scope before minting: %s', async path => {
  const fixture = await setup()
  await expect(fixture.provider.read(path)).rejects.toThrow()
  expect(fixture.requests).toHaveLength(0)
})
it('derives only the minimum read permissions for checks, statuses, runs and contents', () => {
  expect(readerScope('/repos/fortresspower/cmsandbox/rules/branches/main?per_page=100').permissions).toEqual({ metadata: 'read' })
  for (const [suffix, permission] of [[`commits/${head}/check-runs`, 'checks'], [`commits/${head}/status`, 'statuses'], ['actions/runs/1', 'actions'], ['branches/feature', 'contents'], [`compare/${head}...${'b'.repeat(40)}?per_page=100`, 'contents'], [`commits/${head}`, 'contents'], ['tags?per_page=100', 'contents'], ['releases?per_page=100&page=1', 'contents'], [`actions/runs?head_sha=${head}&event=push&per_page=100&page=1`, 'actions'], [`commits/${head}/pulls?per_page=100`, 'pull_requests']]) {
    expect(readerScope(`/repos/fortresspower/cmsandbox/${suffix}`).permissions).toEqual({ metadata: 'read', [permission!]: 'read' })
  }
})
it('refuses unprovisioned credentials, disabled execution, unsafe key modes and the web identity before any token mint', async () => {
  const missing = await setup({ credentials: false }), disabled = await setup({ enabled: false }), unsafe = await setup()
  await expect(missing.provider.read('/repos/fortresspower/cmsandbox/pulls/1')).rejects.toThrow('not provisioned')
  await expect(disabled.provider.read('/repos/fortresspower/cmsandbox/pulls/1')).rejects.toThrow('not provisioned')
  await chmod(join(unsafe.custody, 'reader.pem'), 0o644)
  await expect(unsafe.provider.read('/repos/fortresspower/cmsandbox/pulls/1')).rejects.toThrow('0600')
  expect([...missing.requests, ...disabled.requests, ...unsafe.requests]).toHaveLength(0)
  expect(() => assertBrokerIdentity(missing.config, missing.config.webUid)).toThrow('distinct')
  expect(() => assertBrokerIdentity(missing.config, 0)).toThrow('non-root')
})
it('rejects a broader returned token and never returns its secret or provider errors', async () => {
  const fixture = await setup()
  const broadened = new LiveProvider(fixture.config, async input => {
    if (input.path.endsWith('/access_tokens')) return { status: 201, data: { token: secret, expires_at: new Date(Date.now() + 55 * 60_000).toISOString(), permissions: { metadata: 'read', contents: 'write' }, repositories: [{ id: 5, full_name: 'fortresspower/cmsandbox' }] } }
    throw new Error(secret)
  }, true)
  await expect(broadened.read('/repos/fortresspower/cmsandbox/pulls/1')).rejects.toThrow('exceeds requested')
  expect(broadened.redact({ reflected: secret })).toEqual({ reflected: '[redacted]' })
})
it('the live adapter has no merge path or patch/ref/force/delete write path', async () => {
  const fixture = await setup()
  await expect(fixture.provider.perform(snapshot(), merge)).rejects.toThrow('globally disabled')
  await expect(fixture.provider.perform(snapshot(), { ...update, ref: 'refs/tags/v1' })).rejects.toThrow('differs')
  await expect(fixture.provider.perform({ ...snapshot(), headRef: 'main' }, update)).rejects.toThrow('unprotected')
  await expect(fixture.provider.perform(snapshot(), { ...update, force: true } as ActionOperation)).rejects.toThrow()
  expect(fixture.requests).toHaveLength(0)
})
async function execution(options: Parameters<typeof setup>[0] = {}) {
  const fixture = await setup(options), store = new ActionStore(fixture.config.actions)
  const candidate = installed('fix-ci')
  const action = await store.install({ source: candidate.source, manifest: candidate.manifest }, 'owner')
  const executorFor = () => new ActionExecutor(store, fixture.provider.snapshot, policy, (repository, jobId) => fixture.provider.job(repository, jobId), {
    run: async () => ({ kind: 'ci.propose' }), perform: (target, operation) => fixture.provider.perform(target, operation),
  })
  return { ...fixture, store, action, executor: executorFor(), executorFor }
}
it('safe update rechecks expected head, persists intent before the fake write and completes the audit receipt', async () => {
  const fixture = await execution()
  const input = { ...run(fixture.action), repair: update as Extract<ActionOperation, { kind: 'repair.update' }> }
  const originalPerform = fixture.provider.perform.bind(fixture.provider)
  vi.spyOn(fixture.provider, 'perform').mockImplementation(async (target, operation) => {
    expect((await fixture.store.receipts())[0]).toMatchObject({ outcome: 'intent', actor: 'owner', providerRequest: { body: { expected_head_sha: head } } })
    return originalPerform(target, operation)
  })
  const id = await fixture.executor.start(input); await fixture.executor.wait(id)
  const [receipt] = await fixture.store.receipts()
  expect(receipt).toMatchObject({ actor: 'owner', captured: { url: snapshot().url, head }, operation: update, attempted: ['repair.update'], exercised: ['repair.update'], credentialProfile: 'Repair', outcome: 'accepted', verification: 'accepted', actualGitHubWrites: 1 })
  expect(receipt?.finishedAt).toBeTruthy()
  const write = fixture.requests.find(request => request.path.endsWith('/update-branch'))!
  expect(write).toMatchObject({ method: 'PUT', body: { expected_head_sha: head } })
  expect(fixture.requests.filter(request => request.path.endsWith('/access_tokens')).at(-1)?.body).toEqual({ repository_ids: [5], permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' } })
  const audit = await readFile(join(fixture.config.actions, 'runs', id, 'events.jsonl'), 'utf8')
  expect(audit).not.toContain(secret); expect(audit).not.toContain(privateKey)
})
it('expected-head mismatch refuses before any fake Repair write', async () => {
  const fixture = await execution()
  const input = { ...run(fixture.action), repair: { ...update, expectedHead: 'c'.repeat(40) } as Extract<ActionOperation, { kind: 'repair.update' }> }
  const id = await fixture.executor.start(input); await fixture.executor.wait(id)
  expect((await fixture.store.receipts())[0]?.reasons).toContain('Expected HEAD mismatch')
  expect(fixture.requests.filter(request => request.method !== 'GET' && !request.path.endsWith('/access_tokens'))).toHaveLength(0)
})
it('allows exactly one explicit failed leaf job rerun bound to PR/head/run/job, including after restart', async () => {
  const fixture = await execution()
  const input = { ...run(fixture.action), repair: rerun as Extract<ActionOperation, { kind: 'repair.rerun' }> }
  const first = await fixture.executor.start(input); await fixture.executor.wait(first)
  expect((await fixture.store.receipts())[0]).toMatchObject({ outcome: 'accepted', operation: { jobId: 123, runId: 456, expectedHead: head } })
  await fixture.store.reconcileInterrupted()
  const reloaded = fixture.executorFor()
  const second = await reloaded.start({ ...run(fixture.action), repair: input.repair }); await reloaded.wait(second)
  expect((await fixture.store.receipts()).find(row => row.runId === second)?.reasons.join()).toContain('already consumed')
  expect(fixture.requests.filter(request => request.path.endsWith('/rerun'))).toHaveLength(1)
  expect(fixture.requests.filter(request => request.path.endsWith('/access_tokens')).at(-1)?.body).toEqual({ repository_ids: [5], permissions: { metadata: 'read', actions: 'write' } })
})
it.each(['pull_request', 'dependent', 'matrix', 'dynamic'])('refuses wider or unproven rerun topology: %s', async shape => {
  const fixture = await execution({ response: async input => {
    if (shape === 'pull_request' && input.path.endsWith('/actions/runs/456')) return { id: 456, head_sha: head, run_attempt: 1, event: 'pull_request', path: '.github/workflows/ci.yml', repository: { full_name: 'fortresspower/cmsandbox' } }
    if (input.path.includes('/contents/')) return { encoding: 'base64', content: Buffer.from(shape === 'dependent' ? 'jobs:\n  test: {}\n  deploy:\n    needs: test\n' : shape === 'matrix' ? 'jobs:\n  test:\n    strategy:\n      matrix:\n        os: [linux]\n' : 'jobs:\n  test:\n    name: "${{ matrix.name }}"\n').toString('base64') }
    return undefined
  } })
  const id = await fixture.executor.start({ ...run(fixture.action), repair: rerun as Extract<ActionOperation, { kind: 'repair.rerun' }> }); await fixture.executor.wait(id)
  expect((await fixture.store.receipts())[0]?.reasons.join()).toContain('zero dependent jobs')
  expect(fixture.requests.some(request => request.path.endsWith('/rerun'))).toBe(false)
})

it('serves the existing action API through the private Unix socket, runs isolated source, and migrates inventory without ambient login', async () => {
  const fixture = await setup(), runtime = await stageTestRuntime()
  const { server, api } = await listenBroker({ ...fixture.config, runtime }, fixture.provider)
  vi.stubEnv('TINSTAR_ACTIONS_LIVE', 'reader-repair'); vi.stubEnv('TINSTAR_ACTION_BROKER_SOCKET', fixture.config.socket)
  vi.stubEnv('GH_TOKEN', 'ambient-host-test-secret')
  try {
    expect((await stat(fixture.config.socket)).mode & 0o777).toBe(0o660)
    expect(await new PullReader().identity()).toMatchObject({ account: 'except-pass', authenticatedActor: 'Tin Star Reader App', repositories: [...readerRepositories] })
    await expect(githubJson('/repos/kunchenguid/firstmate/pulls')).rejects.toThrow('ten-repository')
    const original = installed('fix-ci')
    const source = `import fs from 'node:fs'; export default async (_,b)=>{if(Object.keys(process.env).some(key=>/TOKEN|KEY/.test(key)))throw new Error('credential leak');let blocked=false;try{fs.readFileSync(${JSON.stringify(join(fixture.custody, 'reader.pem'))})}catch{blocked=true}if(!blocked)throw new Error('credential mount leaked');await b.read('pr');await b.propose({kind:'ci.propose'});}`
    const candidate = { source, manifest: { ...original.manifest, digest: sourceDigest(source) } }
    expect((await brokerRequest('/api/actions/install', { candidate, inspected: true }, 'stranger')).status).toBe(403)
    const saved = await brokerRequest('/api/actions/install', { candidate, inspected: true }, 'owner')
    expect(saved.status).toBe(200)
    const input = { ...run(original), action: original.manifest.id, version: original.manifest.version, targets: [{ url: snapshot().url, head, base: 'main' }], repair: update }
    const { installed: _installed, actor: _actor, ...payload } = input
    const response = await brokerRequest('/api/actions/run', payload, 'owner')
    expect(response.status).toBe(200)
    const runId = (response.body as { data: { runId: string } }).data.runId
    await api.executor.wait(runId)
    const receipts = await api.store.receipts()
    expect(receipts[0]).toMatchObject({ outcome: 'accepted', actor: 'owner', actualGitHubWrites: 1 })
    expect(await new (await import('../routes')).ActionsApi().receipt(receipts[0]!.id)).toMatchObject({ outcome: 'accepted' })
    const catalog = await brokerRequest('/api/actions', undefined, 'owner')
    expect((catalog.body as { data: { live: boolean } }).data.live).toBe(true)
    const visible = JSON.stringify([saved, response, catalog, await brokerData('/receipt', { id: receipts[0]!.id })])
    for (const value of [secret, privateKey, 'ambient-host-test-secret']) expect(visible).not.toContain(value)
    expect(fixture.requests.filter(request => request.method !== 'GET' && !request.path.endsWith('/access_tokens')).map(request => request.path)).toEqual(['/repos/fortresspower/cmsandbox/pulls/1/update-branch'])
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

it('fails a missing live socket clearly without falling back to the ambient login', async () => {
  vi.stubEnv('TINSTAR_ACTIONS_LIVE', 'reader-repair'); vi.stubEnv('TINSTAR_ACTION_BROKER_SOCKET', '/missing/tinstar-broker.sock')
  await expect(githubJson('/repos/fortresspower/cmsandbox/pulls')).rejects.toThrow('not provisioned')
})

it('rechecks the selected head after token minting and stops a cancellation before sending Repair', async () => {
  const fixture = await setup()
  vi.spyOn(fixture.provider, 'snapshot').mockResolvedValue({ ...snapshot(), head: 'c'.repeat(40) })
  await expect(fixture.provider.perform(snapshot(), update)).rejects.toThrow('immediately before Repair')
  expect(fixture.requests.filter(request => request.path.endsWith('/update-branch'))).toHaveLength(0)
  const controller = new AbortController()
  vi.spyOn(fixture.provider, 'snapshot').mockImplementation(async () => { controller.abort(); return snapshot() })
  await expect(fixture.provider.perform(snapshot(), update, controller.signal)).rejects.toThrow()
  expect(fixture.requests.filter(request => request.path.endsWith('/update-branch'))).toHaveLength(0)
})
it('does not send a mutation if exact audit intent cannot be persisted', async () => {
  const fixture = await execution(), append = fixture.store.append.bind(fixture.store)
  vi.spyOn(fixture.store, 'append').mockImplementationOnce(append).mockRejectedValueOnce(new Error('Audit unavailable')).mockImplementation(append)
  const id = await fixture.executor.start({ ...run(fixture.action), repair: update as Extract<ActionOperation, { kind: 'repair.update' }> }); await fixture.executor.wait(id)
  expect(fixture.requests.filter(request => request.path.endsWith('/update-branch'))).toHaveLength(0)
  expect((await fixture.store.receipts())[0]).toMatchObject({ outcome: 'skipped', actualGitHubWrites: 0 })
})
it('preserves uncertain writes and refuses a same-head retry after restart', async () => {
  const fixture = await execution()
  vi.spyOn(fixture.provider, 'perform').mockRejectedValue(new Error('Ambiguous provider acknowledgment'))
  const first = await fixture.executor.start({ ...run(fixture.action), repair: update as Extract<ActionOperation, { kind: 'repair.update' }> }); await fixture.executor.wait(first)
  expect((await fixture.store.receipts())[0]).toMatchObject({ outcome: 'unknown', actualGitHubWrites: null })
  const restarted = fixture.executorFor()
  const second = await restarted.start({ ...run(fixture.action), repair: update as Extract<ActionOperation, { kind: 'repair.update' }> }); await restarted.wait(second)
  expect(fixture.provider.perform).toHaveBeenCalledTimes(1)
  expect((await fixture.store.receipts()).find(row => row.runId === second)?.reasons.join()).toContain('reconcile provider state')
})

it('checks branch/path grants before giving target evidence to generated source', async () => {
  const fixture = await execution()
  const candidate = installed('explain')
  const action = await fixture.store.install({ source: candidate.source, manifest: { ...candidate.manifest, paths: ['docs/**'] } }, 'owner')
  const evaluate = vi.fn(async () => ({ kind: 'explain' as const }))
  const executor = new ActionExecutor(fixture.store, fixture.provider.snapshot, policy, undefined, { run: evaluate, perform: async () => { throw new Error('must not perform') } })
  const id = await executor.start(run(action)); await executor.wait(id)
  expect(evaluate).not.toHaveBeenCalled()
  expect((await fixture.store.receipts())[0]?.reasons.join()).toContain('Changed path outside installed grant')
})
}, 30_000)

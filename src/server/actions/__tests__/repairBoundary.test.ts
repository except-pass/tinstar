import { expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LiveProvider, brokerConfigSchema, type ProviderTransport } from '../liveProvider'
import { listenBroker } from '../brokerService'
import { ActionsApi } from '../routes'
import { installed, head, baseHead } from './fixtures'
import { sourceDigest } from '../examples'
import { readerRepositories, type ActionOperation, type ActionReceipt } from '../../../shared/actions'
import { stageTestRuntime } from './runtimeFixture'

// Eleven bubblewrap runs plus loopback HTTP. The listener uses an ephemeral
// port so a second suite can bind its own, and the shared runtime stays put.
it('audits live Repair refusals and reconciles an uncertain rerun without repeating its write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'repair-boundary-'))
  const servers: Server[] = []
  let runtime: string | undefined
  const requests: { method: string; path: string; body: unknown }[] = []
  let scenario = '', changed = false, uncertain = false
  const repository = 'fortresspower/cmsandbox'
  const serve = async (server: Server, port = 0) => {
    servers.push(server)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }
  try {
    const github = await serve(createServer((req, res) => {
      void (async () => {
        const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null
        const path = req.url!, method = req.method!
        requests.push({ method, path, body })
        let data: unknown = [], status = 200
        if (path.endsWith('/access_tokens')) {
          if (scenario === 'changed' && body.permissions.contents === 'write') changed = true
          status = 201; data = { token: 'fake-loopback-token', expires_at: new Date(Date.now() + 300_000).toISOString(), permissions: body.permissions,
            repositories: [{ id: 5, full_name: repository }] }
        } else if (path.endsWith('/rerun')) {
          status = scenario.startsWith('uncertain') ? 503 : 201
          if (scenario === 'uncertain') uncertain = true
        } else if (path.endsWith('/update-branch')) { status = 202 }
        else if (/\/pulls\/\d+$/.test(path)) {
          const number = Number(path.split('/').at(-1))
          data = { number, html_url: `https://github.com/${repository}/pull/${number}`, state: 'open', merged: false, draft: false, mergeable: true, changed_files: 1,
            head: { sha: changed ? 'c'.repeat(40) : head, ref: `feature-${number}`, repo: { full_name: repository } }, base: { sha: baseHead, ref: 'main' } }
        } else if (path.includes('/files?')) data = [{ filename: 'components/web-fmp/src/example.ts' }]
        else if (path.includes('/check-runs?')) data = { total_count: 0, check_runs: [] }
        else if (path.endsWith('/status')) data = { total_count: 0 }
        else if (path.includes('/branches/')) data = { protected: false }
        else if (/\/actions\/jobs\/\d+$/.test(path)) data = { id: Number(path.split('/').at(-1)), run_id: scenario === 'other-run' ? 457 : 456, name: 'test', status: 'completed', conclusion: 'failure' }
        else if (/\/actions\/runs\/\d+$/.test(path)) data = { id: Number(path.split('/').at(-1)), head_sha: head, head_branch: 'feature-1', run_attempt: uncertain ? 2 : 1, event: 'push', path: '.github/workflows/ci.yml', repository: { full_name: repository } }
        else if (path.includes('/contents/')) data = { encoding: 'base64', content: Buffer.from(scenario === 'matrix' ? 'jobs:\n  test:\n    strategy:\n      matrix:\n        os: [linux]\n' : scenario === 'reusable' ? 'jobs:\n  test:\n    uses: org/repo/.github/workflows/test.yml@main\n' : 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: []\n').toString('base64') }
        res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data))
      })().catch(error => { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) })
    }))
    // This transport has one fixed loopback origin; it cannot reach GitHub.
    const transport: ProviderTransport = async input => {
      const response = await fetch(github + input.path, { method: input.method, headers: { 'Content-Type': 'application/json' }, body: input.body ? JSON.stringify(input.body) : undefined, redirect: 'error' })
      return { status: response.status, data: await response.json() }
    }
    const custody = join(root, 'credentials'); await mkdir(custody, { mode: 0o700 })
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    for (const profile of ['reader', 'repair']) await writeFile(join(custody, `${profile}.pem`), privateKey, { mode: 0o600 })
    runtime = await stageTestRuntime()
    const config = brokerConfigSchema.parse({ webUid: 12345, ownerLogins: ['owner'], reviewAuthor: 'except-pass', custody, runtime, actions: join(root, 'actions'), socket: join(root, 'broker.sock'),
      reader: { appId: 10, installations: [{ installationId: 20, repositories: Object.fromEntries(readerRepositories.map((name, i) => [name, i + 1])) }] },
      repair: { appId: 11, installations: [{ installationId: 21, repositories: { [repository]: 5 } }] } })
    await writeFile(join(root, 'config.json'), JSON.stringify({ ask: { ownerLogins: ['owner'] } }), { mode: 0o600 })
    const broker = await listenBroker(config, new LiveProvider(config, transport, true)); servers.push(broker.server)
    vi.stubEnv('TINSTAR_ACTIONS_LIVE', 'reader-repair'); vi.stubEnv('TINSTAR_ACTION_BROKER_SOCKET', config.socket)
    const api = new ActionsApi(undefined, undefined, root)
    const preview = await serve(createServer((req, res) => { void api.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end() } }) }))
    const call = async (path: string, body: unknown) => {
      const response = await fetch(preview + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Tinstar-UI': '1', 'Tailscale-User-Login': 'owner' }, body: JSON.stringify(body) })
      const result = await response.json(); expect(response.status, JSON.stringify(result)).toBe(200)
      return result.data
    }
    const original = installed('fix-ci'), source = `export default async(_,b)=>{await b.read('pr');await b.propose({kind:'ci.propose'})}`
    await call('/api/actions/install', { candidate: { source, manifest: { ...original.manifest, digest: sourceDigest(source) } }, inspected: true })
    const receipts: ActionReceipt[] = []
    const execute = async (name: string, operation: ActionOperation) => {
      scenario = name; changed = false; uncertain = false
      const { runId } = await call('/api/actions/run', { key: randomUUID(), action: original.manifest.id, version: original.manifest.version, mode: 'direct', view: { scene: 'pulls' }, targets: [{ url: `https://github.com/${repository}/pull/1`, head, base: 'main' }], repair: operation })
      await broker.api.executor.wait(runId)
      const receipt = (await broker.api.store.receipts()).find(row => row.runId === runId)!
      expect(receipt).toMatchObject({ actor: 'owner', execution: 'live', captured: { head, base: 'main' } })
      expect(receipt.finishedAt).toBeTruthy(); expect(receipt.digest).toBe(sourceDigest(source))
      receipts.push(receipt)
      return receipt
    }
    const update = { kind: 'repair.update' as const, expectedHead: head, ref: 'refs/heads/feature-1' }
    const rerun = { kind: 'repair.rerun' as const, expectedHead: head, jobId: 123, runId: 456, attempt: 1 as const }
    expect((await execute('stale', { ...update, expectedHead: 'c'.repeat(40) })).reasons.join()).toContain('Expected HEAD mismatch')
    expect((await execute('changed', update)).reasons.join()).toContain('immediately before Repair')
    expect(requests.filter(row => row.path.endsWith('/update-branch'))).toHaveLength(0)
    expect((await execute('first', rerun)).outcome).toBe('accepted')
    expect((await execute('second', rerun)).reasons.join()).toContain('already consumed')
    for (const name of ['matrix', 'reusable', 'other-run']) expect((await execute(name, { ...rerun, jobId: 124 })).outcome).toBe('skipped')
    expect(requests.filter(row => row.path.endsWith('/rerun'))).toHaveLength(1)
    const uncertainReceipt = await execute('uncertain', { ...rerun, jobId: 125 })
    const audit = await readFile(join(config.actions, 'runs', uncertainReceipt.runId, 'events.jsonl'), 'utf8')
    const events = audit.trim().split('\n').map(line => JSON.parse(line) as ActionReceipt)
    const writes = requests.filter(row => row.path.endsWith('/jobs/125/rerun'))
    expect(writes).toHaveLength(1)
    const evidence = process.env.TINSTAR_REPAIR_TEST_EVIDENCE
    if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, 'repair-boundary.json'), JSON.stringify({ preview, github, receipts, events, requests, realGitHubCalls: 0 }, null, 2)) }
    expect(events.some(row => row.outcome === 'unknown')).toBe(true)
    expect(uncertainReceipt.outcome).toBe('completed')
    expect(uncertainReceipt.verification).toBe('accepted')
    expect(uncertainReceipt.actualGitHubWrites).toBeNull()
    expect(requests.slice(requests.findIndex(row => row === writes[0]) + 1).some(row => row.method === 'GET' && row.path.endsWith('/actions/runs/456'))).toBe(true)
    expect((await execute('resolved-retry', { ...rerun, jobId: 125 })).reasons.join()).toContain('already consumed')
    expect(requests.filter(row => row.path.endsWith('/jobs/125/rerun'))).toHaveLength(1)
    expect((await execute('uncertain-unchanged', { ...rerun, jobId: 126 })).outcome).toBe('unknown')
    expect((await execute('unknown-retry', { ...rerun, jobId: 126 })).reasons.join()).toContain('reconcile provider state')
    expect(requests.filter(row => row.path.endsWith('/jobs/126/rerun'))).toHaveLength(1)
    if (evidence) await writeFile(join(evidence, 'repair-boundary.json'), JSON.stringify({ preview, github, receipts, events, requests, realGitHubCalls: 0 }, null, 2))
  } finally {
    vi.unstubAllEnvs()
    for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

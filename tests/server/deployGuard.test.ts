import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AskApi } from '../../src/server/ask/routes'
import { compareCatalogs, publicationEvidence, toolsList } from '../../scripts/deploy/post-deploy-smoke.mjs'

const exec = promisify(execFile)
const roots: string[] = [], servers: Server[] = []
const token = 'preview-only-bridge-credential-1234567890', caller = 'Bearer preview-only-caller-credential-1234567890'
const tools = [{ name: 'get_scene', description: 'Scene', inputSchema: { type: 'object', properties: {} } }]
const script = resolve('scripts/deploy/floor-deploy.sh')
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tinstar-deploy-')); roots.push(root)
  await writeFile(join(root, 'config.json'), JSON.stringify({ ask: { ownerLogins: ['owner@example.test'], bridgeToken: token } }), { mode: 0o600 })
  await writeFile(join(root, 'caller'), caller, { mode: 0o600 })
  await writeFile(join(root, 'approved.json'), '["get_scene"]')
  let ready = true, catalog = tools, started = '2026-11-09T18:00:02Z', failBridgeRead = false
  const api = new AskApi({ scene: async () => { throw new Error('Smoke must not query First Mate') } }, root, async () => ({ ownerLogins: ['owner@example.test'], bridgeToken: token }))
  let base = ''
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/ask/')) {
      if (failBridgeRead && req.method === 'GET' && req.url.startsWith('/api/ask/bridge?synthetic_id=')) { res.writeHead(503); res.end('{}'); return }
      await api.handle(req, res); return
    }
    if (req.url === '/readyz') { res.writeHead(ready ? 200 : 503); res.end(ready ? 'ready' : 'startup catalog failed; polling disabled'); return }
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/status') { res.end(JSON.stringify({ started_at: started, channels: [{ name: 'main', enabled: true, probe_status: 'ok', details: [{ key: 'url', value: base + '/target' }] }] })); return }
    if (req.url === '/metrics') { res.end('commands_poll_last_successful_timestamp_seconds{} 1794247205\n'); return }
    if (req.url === '/mcp' || req.url === '/target') {
      if (req.headers.authorization !== caller) { res.writeHead(401); res.end('{}'); return }
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk)
      const message = JSON.parse(Buffer.concat(chunks).toString())
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: req.url === '/mcp' ? tools : catalog } })); return
    }
    res.writeHead(404); res.end('{}')
  })
  servers.push(server)
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const bin = join(root, 'bin'); await mkdir(bin)
  // Exercise real shell control flow with executable command doubles; no units
  // or git checkout outside the temporary fixture can be touched by these tests.
  const command = '#!/bin/bash\nname=${0##*/}\nprintf "%s %s\\n" "$name" "$*" >> "$COMMAND_LOG"\nif [[ "$name $*" == "npm run test:unit" && "${FAIL_TESTS:-}" == 1 ]]; then exit 42; fi\n'
  for (const name of ['git', 'npm', 'sudo']) await writeFile(join(bin, name), command, { mode: 0o700 })
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: join(root, 'commands.log'), TINSTAR_DEPLOY_SOURCE: root,
    TINSTAR_CONFIG_HOME: root, TINSTAR_DEPLOY_BLOCK: join(root, 'deploy.blocked'), TINSTAR_OWNER_URL: base, TINSTAR_BRIDGE_URL: base,
    TINSTAR_FACADE_URL: base + '/mcp', TINSTAR_TUNNEL_TARGET_URL: base + '/target', TINSTAR_TUNNEL_HEALTH_URL: base,
    TINSTAR_FACADE_STARTED_AT: '2026-11-09T18:00:01Z', TINSTAR_CALLER_HEADER_FILE: join(root, 'caller'), TINSTAR_APPROVED_TOOLS_FILE: join(root, 'approved.json'), TINSTAR_SMOKE_WAIT_MS: '0' }
  const run = async (checkOnly = false, override: Record<string, string> = {}) => {
    try { const result = await exec('bash', [script, ...(checkOnly ? ['--check-only'] : [])], { env: { ...env, ...override } }); return { ...result, code: 0 } }
    catch (error) { const result = error as { stdout: string; stderr: string; code: number }; return result }
  }
  return { root, base, run, setFailBridgeRead: () => { failBridgeRead = true }, setReady: (value: boolean) => { ready = value }, setCatalog: (value: typeof tools) => { catalog = value }, setStarted: (value: string) => { started = value } }
}

describe('floor deploy executable', () => {
  it('gates all restarts on tests, then round trips Ask, removes its row and verifies MCP', async () => {
    const { root, run } = await fixture()
    const result = await run()
    expect(result.code, result.stderr).toBe(0)
    const commands = (await readFile(join(root, 'commands.log'), 'utf8')).trim().split('\n')
    expect(commands).toEqual(['git status --porcelain', 'git fetch origin main', 'git checkout --detach origin/main', 'npm ci --include=dev', 'npm run typecheck', 'npm run test:unit', 'npm run build:all',
      'sudo -n systemctl restart tinstar-floor', 'sudo -n systemctl restart tinstar-mcp-facade', 'sudo -n systemctl restart tinstar-mcp-shim', 'sudo -n systemctl restart tinstar-mcp-tunnel'])
    expect(JSON.parse(await readFile(join(root, 'ask-requests.json'), 'utf8'))).toEqual([])
    await expect(readFile(join(root, 'deploy.blocked'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.stdout).toContain('Ask and MCP smoke passed')
    expect(result.stdout + result.stderr).not.toContain(token)
    expect(result.stdout + result.stderr).not.toContain(caller)
  })
  it('blocks before build or restart when tests fail and refuses the next deploy before git', async () => {
    const { root, run } = await fixture()
    const result = await run(false, { FAIL_TESTS: '1' })
    expect(result.code).toBe(42)
    expect(result.stderr.match(/ALERT/g)).toHaveLength(1)
    expect(await readFile(join(root, 'deploy.blocked'), 'utf8')).toContain('phase=unit-tests')
    const commands = await readFile(join(root, 'commands.log'), 'utf8')
    expect(commands).not.toContain('build:all')
    expect(commands).not.toContain('sudo')
    expect((await run()).code).not.toBe(0)
    expect(await readFile(join(root, 'commands.log'), 'utf8')).toBe(commands)
  })
  it('cleans the synthetic partition when a bridge check fails after creating the question', async () => {
    const { root, run, setFailBridgeRead } = await fixture()
    setFailBridgeRead()
    const result = await run(true)
    expect(result.code).not.toBe(0)
    expect(JSON.parse(await readFile(join(root, 'ask-requests.json'), 'utf8'))).toEqual([])
    expect(await readFile(join(root, 'deploy.blocked'), 'utf8')).toContain('phase=post-deploy-smoke')
  })
  it.each(['not ready', 'catalog drift', 'stale publication', 'owner failure'])('latches %s and leaves no synthetic records or credentials in output', async reason => {
    const { root, run, setReady, setCatalog, setStarted } = await fixture()
    if (reason === 'not ready') setReady(false)
    if (reason === 'catalog drift') setCatalog([])
    if (reason === 'stale publication') setStarted('2026-11-09T17:00:00Z')
    const result = await run(true, reason === 'owner failure' ? { TINSTAR_OWNER_URL: 'http://127.0.0.1:1' } : {})
    expect(result.code).not.toBe(0)
    expect(await readFile(join(root, 'deploy.blocked'), 'utf8')).toContain('phase=post-deploy-smoke')
    if (reason !== 'owner failure') expect(JSON.parse(await readFile(join(root, 'ask-requests.json'), 'utf8'))).toEqual([])
    expect(result.stderr.match(/ALERT/g)).toHaveLength(1)
    expect(result.stdout + result.stderr).not.toContain(token)
    expect(result.stdout + result.stderr).not.toContain(caller)
    await expect(readFile(join(root, 'commands.log'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

it('compares full catalog semantics, tolerates object order and rejects duplicate/extra/mutated tools', () => {
  expect(() => compareCatalogs(tools, [{ inputSchema: { properties: {}, type: 'object' }, description: 'Scene', name: 'get_scene' }], ['get_scene'])).not.toThrow()
  for (const target of [[], [...tools, ...tools], [{ ...tools[0], inputSchema: { type: 'object' } }]]) expect(() => compareCatalogs(tools, target, ['get_scene'])).toThrow()
  expect(() => compareCatalogs(tools, tools, ['get_scene', 'unexpected'])).toThrow()
})
it('requires the current target, facade freshness and a successful post-start poll', () => {
  const status = { started_at: '2026-11-09T18:00:02Z', channels: [{ name: 'main', enabled: true, probe_status: 'ok', details: [{ value: 'http://target/mcp' }] }] }
  const metric = 'commands_poll_last_successful_timestamp_seconds 1794247205\n'
  expect(() => publicationEvidence(status, metric, '2026-11-09T18:00:01Z', 'http://target/mcp')).not.toThrow()
  for (const [s, m, at, url] of [[status, '', '2026-11-09T18:00:01Z', 'http://target/mcp'], [status, metric, '2026-11-09T18:00:03Z', 'http://target/mcp'], [status, metric, '2026-11-09T18:00:01Z', 'http://other/mcp'], [{ ...status, started_at: '' }, metric, '2026-11-09T18:00:01Z', 'http://target/mcp']] as const) expect(() => publicationEvidence(s, m, at, url)).toThrow()
})
it('reads tools/list from the executable MCP interface', async () => {
  const { base } = await fixture()
  expect(await toolsList(base + '/mcp', caller)).toEqual(tools)
  await expect(toolsList(base + '/mcp', 'Bearer invalid')).rejects.toThrow()
})

it('lists the real facade catalog using the same wire request as the smoke', async () => {
  const { ReconciliationMcp } = await import('../../src/server/reconciliation/mcp')
  const { createTunnelFacade } = await import('../../src/server/reconciliation/tunnel')
  const { fixtureScene, fixtureSources } = await import('../../test-fixtures/reconciliation/scenes')
  const { buildWorkerLinkReport } = await import('../../src/server/reconciliation/workerLinkReport')
  const root = await mkdtemp(join(tmpdir(), 'tinstar-deploy-mcp-')); roots.push(root)
  const mcp = new ReconciliationMcp({ scene: async () => fixtureScene(), card: async () => ({ outcome: 'unavailable' }),
    queue: async () => ({ outcome: 'queue-source-unavailable', message: 'Unavailable' }), workerLinkReport: async () => buildWorkerLinkReport(fixtureSources()),
  }, root)
  const backend = createServer((req, res) => { void mcp.handle(req, res) }); servers.push(backend)
  await new Promise<void>(done => backend.listen(0, '127.0.0.1', done))
  const facade = createTunnelFacade({ upstreamPort: (backend.address() as { port: number }).port,
    installToken: (await readFile(join(root, 'mcp-token'), 'utf8')).trim(), caller: { id: 'deploy-preview', token: caller.slice(7), allowView: true } })
  servers.push(facade.server); await facade.listen(0)
  const catalog = await toolsList(`http://127.0.0.1:${(facade.server.address() as { port: number }).port}/mcp`, caller)
  const approved = JSON.parse(await readFile(resolve('scripts/deploy/approved-tools.json'), 'utf8'))
  expect(() => compareCatalogs(catalog, catalog, approved)).not.toThrow()
})

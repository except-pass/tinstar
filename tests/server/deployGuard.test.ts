import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AskApi } from '../../src/server/ask/routes'
import { ReviewDeploymentAudit, ReviewDeploymentReconciler } from '../../src/server/reconciliation/reviewDeployment'
import { AssociationStore } from '../../src/server/releases/associations'
import { fixtureScene } from '../../test-fixtures/reconciliation/scenes'
import { compareCatalogs, publicationEvidence, toolsList } from '../../scripts/deploy/post-deploy-smoke.mjs'

const exec = promisify(execFile)
const roots: string[] = [], servers: Server[] = []
const token = 'preview-only-bridge-credential-1234567890', caller = 'Bearer preview-only-caller-credential-1234567890'
const tools = [{ name: 'get_scene', description: 'Scene', inputSchema: { type: 'object', properties: {} } }]
const script = resolve('scripts/deploy/floor-deploy.sh')
// A deploy runs this suite with its own exported configuration. Never let those
// unit names, live paths/URLs or shell/Node startup hooks leak into fixtures.
const relatedEnv = new Set(['COMMAND_LOG', 'FAIL_TESTS', 'FAIL_TYPECHECK', 'FAIL_VOICE', 'MISSING_UNIT', 'NODE_ENV', 'NODE_OPTIONS', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'CDPATH'])
const deploymentEnv = (key: string) => key.startsWith('TINSTAR_') || key.startsWith('DEPLOY_FIXTURE_') || relatedEnv.has(key)
beforeEach(async () => {
  for (const key of Object.keys(process.env)) if (deploymentEnv(key)) vi.stubEnv(key, undefined)
  const root = await mkdtemp(join(tmpdir(), 'tinstar-deploy-env-')); roots.push(root)
  vi.stubEnv('TINSTAR_CONFIG_HOME', root)
})
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})
async function fixture(isolatedDeploy = false) {
  const root = await mkdtemp(join(tmpdir(), 'tinstar-deploy-')); roots.push(root)
  await writeFile(join(root, 'config.json'), JSON.stringify({ ask: { ownerLogins: ['owner@example.test'], bridgeToken: token } }), { mode: 0o600 })
  await writeFile(join(root, 'caller'), caller, { mode: 0o600 })
  await writeFile(join(root, 'approved.json'), '["get_scene"]')
  await writeFile(join(root, 'package.json'), '{}')
  await writeFile(join(root, 'package-lock.json'), '{}')
  // The real deploy invokes Node with the service config. This executable CLI
  // double records that interface without downloading anything in unit tests.
  let executable = script
  if (isolatedDeploy) {
    const deploy = join(root, 'scripts', 'deploy')
    await mkdir(deploy, { recursive: true })
    await mkdir(join(root, 'src/shared'), { recursive: true })
    for (const name of ['reviewEvidence.mjs', 'reviewHandoff.mjs']) await cp(resolve('src/shared', name), join(root, 'src/shared', name))
    for (const name of ['floor-deploy.sh', 'deploy-support.mjs', 'post-deploy-smoke.mjs', 'review-handoff.mjs']) await cp(resolve('scripts/deploy', name), join(deploy, name))
    executable = join(deploy, 'floor-deploy.sh')
  }
  await mkdir(join(root, 'bin'))
  await writeFile(join(root, 'bin/tinstar.js'), `
const fs = require('node:fs');
const command = process.argv.slice(2).join(' ');
fs.appendFileSync(process.env.COMMAND_LOG, 'voice-cli ' + command + ' config=' + process.env.TINSTAR_CONFIG_HOME + '\\n');
if (process.env.FAIL_VOICE === '1') process.exit(43);
`)

  let ready = true, catalog = tools, started = '2026-11-09T18:00:02Z', failBridgeRead = false
  let deployedSha: string | null = null
  const api = new AskApi({ scene: async () => { throw new Error('Smoke must not query First Mate') } }, root, async () => ({ ownerLogins: ['owner@example.test'], bridgeToken: token }))
  let base = ''
  const server = createServer(async (req, res) => {
    if (req.url?.startsWith('/api/ask/')) {
      if (failBridgeRead && req.method === 'GET' && req.url.startsWith('/api/ask/bridge?synthetic_id=')) { res.writeHead(503); res.end('{}'); return }
      await api.handle(req, res); return
    }
    if (req.url === '/readyz') { res.writeHead(ready ? 200 : 503); res.end(ready ? 'ready' : 'startup catalog failed; polling disabled'); return }
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/deployment' && deployedSha) { res.end(JSON.stringify({ ok: true, data: { sha: deployedSha } })); return }
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
  const bin = join(root, 'bin')
  // Exercise real shell control flow with executable command doubles; no units
  // or git checkout outside the temporary fixture can be touched by these tests.
  const command = `#!/bin/bash
name=\${0##*/}
printf '%s %s\\n' "$name" "$*" >> "$COMMAND_LOG"
if [[ "$name" == systemctl ]]; then
  if [[ "\${MISSING_UNIT:-}" == 1 ]]; then echo not-found; else echo loaded; fi
fi
if [[ "$name $*" == *'rev-parse HEAD' ]]; then echo "\${DEPLOY_FIXTURE_HEAD:-fixture-head}"; fi
if [[ "$name $*" == 'npm ci --include=dev' && -n "\${DEPLOY_FIXTURE_ZOD:-}" ]]; then
  [[ ! -e node_modules ]] || exit 44
  printf 'old-sha=%s\\n' "$TINSTAR_PREVIOUS_DEPLOYED_SHA" >> "$COMMAND_LOG"
  mkdir node_modules
  cp -R "$DEPLOY_FIXTURE_ZOD" node_modules/zod
fi
if [[ "$name $*" == 'npm run typecheck' && "\${FAIL_TYPECHECK:-}" == 1 ]]; then exit 41; fi
if [[ "$name $*" == 'npm run test:unit'* && "\${FAIL_TESTS:-}" != '' ]]; then
  for arg in "$@"; do
    if [[ "$arg" == --outputFile=* ]]; then
      if [[ "$FAIL_TESTS" != 3 ]]; then printf '%s' '{"testResults":[{"name":"tests/slow.test.ts","status":"failed"},{"name":"tests/other.test.ts","status":"failed"},{"name":"tests/passing.test.ts","status":"passed"}]}' > "\${arg#--outputFile=}"; fi
      exit 42
    fi
  done
  if [[ "$FAIL_TESTS" == 1 ]]; then exit 42; fi
fi
`
  for (const name of ['git', 'npm', 'sudo', 'systemctl']) await writeFile(join(bin, name), command, { mode: 0o700 })
  if (isolatedDeploy) await writeFile(join(bin, 'node'), `#!/bin/bash
if [[ "$2" == old-sha && "\${DEPLOY_FIXTURE_FAIL_PROBE:-}" == 1 ]]; then exit 47; fi
exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"
`, { mode: 0o700 })
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !deploymentEnv(key)))
  const env = { ...inherited, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: join(root, 'commands.log'), TINSTAR_DEPLOY_SOURCE: root,
    ...(isolatedDeploy ? { DEPLOY_FIXTURE_HEAD: 'a'.repeat(40), DEPLOY_FIXTURE_ZOD: resolve('node_modules/zod') } : {}),
    TINSTAR_CONFIG_HOME: root, TINSTAR_DEPLOY_BLOCK: join(root, 'deploy.blocked'), TINSTAR_OWNER_URL: base, TINSTAR_BRIDGE_URL: base,
    TINSTAR_FACADE_URL: base + '/mcp', TINSTAR_TUNNEL_TARGET_URL: base + '/target', TINSTAR_TUNNEL_HEALTH_URL: base,
    TINSTAR_FACADE_STARTED_AT: '2026-11-09T18:00:01Z', TINSTAR_CALLER_HEADER_FILE: join(root, 'caller'), TINSTAR_APPROVED_TOOLS_FILE: join(root, 'approved.json'), TINSTAR_SMOKE_WAIT_MS: '0' }
  const run = async (checkOnly = false, override: Record<string, string> = {}, args: string[] = []) => {
    try { const result = await exec('bash', [executable, ...(checkOnly ? ['--check-only'] : []), ...args], { env: { ...env, ...override } }); return { ...result, code: 0 } }
    catch (error) { const result = error as { stdout: string; stderr: string; code: number }; return result }
  }
  return { root, base, run, setDeployedSha: (value: string) => { deployedSha = value }, setFailBridgeRead: () => { failBridgeRead = true }, setReady: (value: boolean) => { ready = value }, setCatalog: (value: typeof tools) => { catalog = value }, setStarted: (value: string) => { started = value } }
}

describe('floor deploy executable', () => {
  it.each(['known', 'unavailable', 'process failure'])('deploys without node_modules when the old-SHA probe reports %s', async failure => {
    const { root, run, setDeployedSha } = await fixture(true)
    const previous = failure === 'known' ? 'b'.repeat(40) : null
    if (previous) setDeployedSha(previous)
    await expect(readFile(join(root, 'node_modules/zod/package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const result = await run(false, failure === 'process failure' ? { DEPLOY_FIXTURE_FAIL_PROBE: '1' } : {})
    expect(result.code, result.stderr).toBe(0)
    const commands = await readFile(join(root, 'commands.log'), 'utf8')
    expect(commands).toContain(`old-sha=${previous ?? 'unknown'}`)
    expect(commands).toContain('npm ci --include=dev')
    expect(commands).toContain('npm run build:all')
    expect(commands).toContain('sudo -n systemctl restart tinstar-floor')
    const entries = (await readFile(join(root, 'deploy.blocked.audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(entries.find(row => row.action === 'floor-deployment')).toMatchObject({ oldSha: previous, newSha: 'a'.repeat(40), membershipComplete: previous !== null,
      ...(!previous ? { warnings: expect.arrayContaining([expect.stringContaining('Previous running revision is unknown')]) } : {}) })
    if (!previous) {
      const audit = new ReviewDeploymentAudit(root), update = vi.fn()
      await new ReviewDeploymentReconciler(audit, { scene: async () => fixtureScene(), associations: new AssociationStore(root), update, deliver: async () => ({ saved: true }) }).run(true)
      expect((await new ReviewDeploymentAudit(root).exceptions())[0]).toMatchObject({ resolved: false, deployedSha: 'a'.repeat(40), owner: 'Firstmate',
        missing: expect.arrayContaining(['Complete deployed old/new SHA and PR membership evidence']) })
      expect(update).not.toHaveBeenCalled()
    }
    expect(result.stderr).toContain('review handoff incomplete; healthy floor retained')
    expect(result.stdout).toContain('Ask and MCP smoke passed')
    await expect(readFile(join(root, 'deploy.blocked'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('gates all restarts on tests, then round trips Ask, removes its row and verifies MCP', async () => {
    const { root, run } = await fixture()
    const result = await run()
    expect(result.code, result.stderr).toBe(0)
    const commands = (await readFile(join(root, 'commands.log'), 'utf8')).trim().split('\n')
    expect(commands.filter(line => line.startsWith('sudo -n systemctl restart'))).toEqual([
      'sudo -n systemctl restart tinstar-floor', 'sudo -n systemctl restart tinstar-mcp-facade', 'sudo -n systemctl restart tinstar-mcp-tunnel'])
    expect(commands.findIndex(line => line.startsWith('npm run test:unit -- --reporter=default --reporter=json --outputFile='))).toBeGreaterThan(commands.indexOf('npm run typecheck'))
    expect(commands.indexOf('npm run build:all')).toBeGreaterThan(commands.indexOf('npm run typecheck'))
    expect(JSON.parse(await readFile(join(root, 'ask-requests.json'), 'utf8'))).toEqual([])
    await expect(readFile(join(root, 'deploy.blocked'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(result.stdout).toContain('Ask and MCP smoke passed')
    expect(result.stdout + result.stderr).not.toContain(token)
    expect(result.stdout + result.stderr).not.toContain(caller)
  })
  it('ignores ambient deploy settings and startup hooks', async () => {
    const ambient = await mkdtemp(join(tmpdir(), 'tinstar-deploy-ambient-')); roots.push(ambient)
    const shellHook = join(ambient, 'shell-hook')
    await writeFile(shellHook, 'exit 88\n')
    const poison = {
      TINSTAR_FLOOR_UNIT: 'ambient-floor', TINSTAR_FACADE_UNIT: 'ambient-facade', TINSTAR_TUNNEL_UNIT: 'ambient-tunnel', TINSTAR_SHIM_UNIT: 'retired-ambient-shim',
      TINSTAR_CONFIG_HOME: join(ambient, 'config'), TINSTAR_DATA_DIR: join(ambient, 'data'), TINSTAR_DEPLOY_SOURCE: join(ambient, 'source'), TINSTAR_DEPLOY_BLOCK: join(ambient, 'block'),
      TINSTAR_OWNER_URL: 'http://127.0.0.1:1', TINSTAR_BRIDGE_URL: 'http://127.0.0.1:1', TINSTAR_FACADE_URL: 'http://127.0.0.1:1',
      TINSTAR_TUNNEL_TARGET_URL: 'http://127.0.0.1:1', TINSTAR_TUNNEL_HEALTH_URL: 'http://127.0.0.1:1', TINSTAR_SMOKE_WAIT_MS: '600000',
      TINSTAR_CALLER_HEADER_FILE: join(ambient, 'caller'), TINSTAR_APPROVED_TOOLS_FILE: join(ambient, 'tools'), TINSTAR_FACADE_STARTED_AT: 'invalid',
      FAIL_TESTS: '1', COMMAND_LOG: join(ambient, 'log'), NODE_OPTIONS: `--require=${join(ambient, 'missing-hook')}`, BASH_ENV: shellHook,
    }
    for (const [key, value] of Object.entries(poison)) vi.stubEnv(key, value)
    const { root, run } = await fixture()
    const result = await run()
    expect(result.code, result.stderr).toBe(0)
    const commands = await readFile(join(root, 'commands.log'), 'utf8')
    expect(commands).not.toContain('ambient')
    expect(commands).not.toContain('shim')
    expect(commands).toContain('sudo -n systemctl restart tinstar-floor')
    expect(commands).toContain('sudo -n systemctl restart tinstar-mcp-tunnel')
  })
  it.each(['0', '1'])('provisions voice after build with service config and continues on failure=%s', async failure => {
    const { root, run } = await fixture()
    const result = await run(false, { FAIL_VOICE: failure })
    expect(result.code, result.stderr).toBe(0)
    const commands = (await readFile(join(root, 'commands.log'), 'utf8')).trim().split('\n')
    const build = commands.indexOf('npm run build:all')
    expect(commands.slice(build, build + 3)).toEqual([
      'npm run build:all', `voice-cli voice install config=${root}`, `voice-cli voice status config=${root}`,
    ])
    expect(commands.indexOf('sudo -n systemctl restart tinstar-floor')).toBeGreaterThan(build + 2)
    if (failure === '1') {
      expect(result.stderr).toContain('voice model install failed; continuing deploy')
      expect(result.stderr).toContain('voice model status failed; continuing deploy')
    }
    await expect(readFile(join(root, 'deploy.blocked'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('restarts a legacy shim only when the fixture explicitly opts in', async () => {
    const { root, run } = await fixture()
    const optional = await run(false, { TINSTAR_SHIM_UNIT: 'preview-shim' })
    expect(optional.code, optional.stderr).toBe(0)
    const commands = await readFile(join(root, 'commands.log'), 'utf8')
    expect(commands).toContain('sudo -n systemctl restart tinstar-mcp-facade\nsudo -n systemctl restart preview-shim\nsudo -n systemctl restart tinstar-mcp-tunnel')
  })
  it('reruns failures once, blocks before build/restart, and refuses the next deploy before fetching', async () => {
    const { root, run } = await fixture()
    const result = await run(false, { FAIL_TESTS: '1' })
    expect(result.code).toBe(42)
    expect(result.stderr.match(/ALERT/g)).toHaveLength(1)
    expect(await readFile(join(root, 'deploy.blocked'), 'utf8')).toContain('phase=unit-tests')
    const commands = await readFile(join(root, 'commands.log'), 'utf8')
    expect(commands).not.toContain('build:all')
    expect(commands).not.toContain('sudo -n systemctl restart')
    expect((await run()).code).not.toBe(0)
    expect((await readFile(join(root, 'commands.log'), 'utf8')).match(/git fetch origin main/g)).toHaveLength(1)
    expect(commands).toContain('npm run test:unit -- tests/slow.test.ts --no-file-parallelism --maxWorkers=1 --minWorkers=1 --isolate')
    expect(commands).toContain('npm run test:unit -- tests/other.test.ts --no-file-parallelism --maxWorkers=1 --minWorkers=1 --isolate')
    expect(commands).not.toContain('npm run test:unit -- tests/passing.test.ts')
  })
  it('warns and audits when only the isolated serial rerun passes', async () => {
    const { root, run } = await fixture()
    const result = await run(false, { FAIL_TESTS: '2' })
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toContain('WARNING Tin Star deploy: Full suite failed; isolated serial rerun passed: tests/slow.test.ts, tests/other.test.ts')
    const entries = (await readFile(join(root, 'deploy.blocked.audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ action: 'warning', gate: 'unit-tests', head: 'fixture-head' })
    expect(entries[0].reason).toContain('tests/slow.test.ts, tests/other.test.ts')
    expect(await readFile(join(root, 'commands.log'), 'utf8')).toContain('sudo -n systemctl restart tinstar-floor')
  })
  it('blocks when the failed-file report is unavailable', async () => {
    const { root, run } = await fixture()
    const result = await run(false, { FAIL_TESTS: '3' })
    expect(result.code).toBe(42)
    expect(result.stderr).toContain('cannot isolate a rerun')
    expect(await readFile(join(root, 'commands.log'), 'utf8')).not.toContain('build:all')
  })
  it('clears a block with a visible structured audit even with unreadable credentials', async () => {
    const { root, run } = await fixture()
    await writeFile(join(root, 'deploy.blocked'), 'phase=unit-tests\n')
    await rm(join(root, 'config.json'))
    const reason = 'Investigated timeout; retry "serially"\nwith owner approval'
    const result = await run(false, {}, ['--clear-block', reason])
    expect(result.code, result.stderr).toBe(0)
    await expect(readFile(join(root, 'deploy.blocked'))).rejects.toMatchObject({ code: 'ENOENT' })
    const lines = (await readFile(join(root, 'deploy.blocked.audit.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ action: 'clear-block', gate: 'block', reason, head: 'fixture-head', user: expect.any(String), time: expect.any(String) })
    expect(Number.isFinite(Date.parse(JSON.parse(lines[0]!).time))).toBe(true)
    expect(result.stderr).toContain(lines[0])
    expect(await readFile(join(root, 'commands.log'), 'utf8')).not.toContain('npm')
  })
  it('requires a reason for every override and clear-block', async () => {
    const { root, run } = await fixture()
    for (const args of [['--override'], ['--override', '  '], ['--clear-block'], ['--clear-block', '']]) {
      expect((await run(false, {}, args)).code).toBe(2)
    }
    await expect(readFile(join(root, 'deploy.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'deploy.blocked.audit.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('audits every overridden gate, clears the old block, and does not persist an override', async () => {
    const { root, run } = await fixture()
    await writeFile(join(root, 'deploy.blocked'), 'phase=unit-tests\n')
    const result = await run(false, { FAIL_TESTS: '1', FAIL_TYPECHECK: '1' }, ['--override', 'Owner accepts known failures'])
    expect(result.code, result.stderr).toBe(0)
    const lines = (await readFile(join(root, 'deploy.blocked.audit.jsonl'), 'utf8')).trim().split('\n')
    expect(lines.map(line => JSON.parse(line).gate)).toEqual(['invocation', 'block', 'typecheck', 'unit-tests'])
    for (const line of lines) {
      expect(JSON.parse(line)).toMatchObject({ action: JSON.parse(line).gate === 'invocation' ? 'override-request' : 'override', reason: 'Owner accepts known failures', head: 'fixture-head', user: expect.any(String), time: expect.any(String) })
      expect(result.stderr).toContain(line)
    }
    expect(result.stderr).toContain('completed with audited overrides')
    await expect(readFile(join(root, 'deploy.blocked'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await run(false, { FAIL_TYPECHECK: '1' })).code).toBe(41)
  }, 15_000) // Two complete deploy invocations include several child processes.
  it('logs override requests even when no gate fails', async () => {
    const { root, run } = await fixture()
    const result = await run(true, {}, ['--override', 'Owner requested a recovery check'])
    expect(result.code, result.stderr).toBe(0)
    const line = (await readFile(join(root, 'deploy.blocked.audit.jsonl'), 'utf8')).trim()
    expect(JSON.parse(line)).toMatchObject({ action: 'override-request', gate: 'invocation', reason: 'Owner requested a recovery check' })
    expect(result.stderr).toContain(line)
  })
  it('stops before deploying or clearing if the audit log cannot be written', async () => {
    const { root, run } = await fixture()
    await mkdir(join(root, 'deploy.blocked.audit.jsonl'))
    await writeFile(join(root, 'deploy.blocked'), 'phase=unit-tests\n')
    for (const option of ['--clear-block', '--override']) {
      const result = await run(false, {}, [option, 'Investigated failure'])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('Cannot append deploy audit log')
      expect(await readFile(join(root, 'deploy.blocked'), 'utf8')).toContain('phase=unit-tests')
    }
    expect(await readFile(join(root, 'commands.log'), 'utf8')).not.toContain('npm')
  })
  it('names an MCP scope difference and permits an audited override', async () => {
    const { root, run } = await fixture()
    await writeFile(join(root, 'approved.json'), '["old_tool"]')
    const failed = await run(true)
    expect(failed.code).not.toBe(0)
    expect(failed.stderr).toContain('missing=["old_tool"], added=["get_scene"]')
    const result = await run(true, {}, ['--override', 'Deliberate scope change'])
    expect(result.code, result.stderr).toBe(0)
    const entries = (await readFile(join(root, 'deploy.blocked.audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(entries.map(entry => entry.gate)).toEqual(['invocation', 'block', 'post-deploy-smoke'])
  }, 15_000) // Two complete deploy invocations include several child processes.
  it.each(['credentials', 'units', 'ports', 'source'])('checks %s before taking the lock or installing dependencies', async kind => {
    const { root, run } = await fixture()
    const env: Record<string, string> = {}
    if (kind === 'credentials') await rm(join(root, 'caller'))
    if (kind === 'units') env.MISSING_UNIT = '1'
    if (kind === 'ports') env.TINSTAR_BRIDGE_URL = 'http://127.0.0.1:1'
    if (kind === 'source') env.TINSTAR_DEPLOY_SOURCE = join(root, 'missing-source')
    const result = await run(false, env)
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('preflight failed; no deploy started')
    if (kind === 'source') expect(result.stderr).toContain('disk space unavailable or below 256 MiB:')
    if (kind === 'ports') expect(result.stderr).toContain('bridge: invalid URL or unavailable port')
    await expect(readFile(join(root, 'deploy.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    const commands = await readFile(join(root, 'commands.log'), 'utf8')
    expect(commands).not.toContain('npm')
    expect(commands).not.toContain('git fetch')
    expect(commands).not.toContain('sudo -n systemctl restart')
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
    if (reason === 'owner failure') {
      await expect(readFile(join(root, 'deploy.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
    } else expect(await readFile(join(root, 'deploy.blocked'), 'utf8')).toContain('phase=post-deploy-smoke')
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
  expect(() => compareCatalogs(tools, tools, ['get_scene', 'get_scene'])).toThrow()
  const schema = { name: 'schema', inputSchema: { type: 'object', required: ['a', 'b'], properties: { a: { enum: ['x', 'y'] } } } }
  expect(() => compareCatalogs([schema], [{ ...schema, inputSchema: { ...schema.inputSchema, required: ['b', 'a'], properties: { a: { enum: ['y', 'x'] } } } }], ['schema'])).not.toThrow()
})
it.each(['allOf', 'anyOf', 'oneOf'])('ignores object-key and alternative ordering in %s schemas', keyword => {
  for (const field of ['inputSchema', 'outputSchema']) {
    const original = { name: 'schema', [field]: { [keyword]: [
      { type: 'string', minLength: 1 }, { type: 'number', minimum: 1 },
    ] } }
    const reordered = { name: 'schema', [field]: { [keyword]: [
      { minimum: 1, type: 'number' }, { minLength: 1, type: 'string' },
    ] } }
    const nested = (tool: typeof original) => ({ name: tool.name, [field]: { properties: { value: tool[field] } } })
    for (const wrap of [(tool: typeof original) => tool, nested]) {
      expect(() => compareCatalogs([wrap(original)], [wrap(reordered)], ['schema'])).not.toThrow()
      expect(() => compareCatalogs([wrap(reordered)], [wrap(original)], ['schema'])).not.toThrow()
    }
    const changed = { name: 'schema', [field]: { [keyword]: [
      { type: 'string', minLength: 2 }, { type: 'number', minimum: 1 },
    ] } }
    expect(() => compareCatalogs([original], [changed], ['schema'])).toThrow()
  }
})
it('preserves array values in schema defaults and tool metadata', () => {
  const tool = { name: 'data', inputSchema: { type: 'object', default: { required: ['a', 'b'] } }, _meta: { enum: ['x', 'y'] } }
  expect(() => compareCatalogs([tool], [{ ...tool, inputSchema: { ...tool.inputSchema, default: { required: ['b', 'a'] } } }], ['data'])).toThrow()
  expect(() => compareCatalogs([tool], [{ ...tool, _meta: { enum: ['y', 'x'] } }], ['data'])).toThrow()
})

it('requires the current target, facade freshness and a successful post-start poll', () => {
  const status = { started_at: '2026-11-09T18:00:02Z', channels: [{ name: 'main', enabled: true, probe_status: 'ok', details: [{ value: 'http://target/mcp' }] }] }
  const metric = 'commands_poll_last_successful_timestamp_seconds 1794247205\n'
  expect(() => publicationEvidence(status, metric, '2026-11-09T18:00:01Z', 'http://target/mcp')).not.toThrow()
  expect(() => publicationEvidence({ ...status, started_at: '2026-11-09T13:00:02-05:00' }, metric, '2026-11-09T19:00:01+01:00', 'http://target/mcp')).not.toThrow()
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

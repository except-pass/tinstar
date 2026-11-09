/** Built-server counterpart of the AskApi contract test; no live services. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { publishedPullerContract } from '../test-fixtures/published-puller/contract'
import type { publicAsk } from '../src/shared/ask'

const root = await mkdtemp(join(tmpdir(), 'tinstar-published-puller-'))
const config = join(root, 'config')
const home = join(root, 'home')
const bin = join(root, 'bin')
const owner = 'owner@example.test'
const token = 'isolated-test-bridge-token-1234567890'
await Promise.all([config, home, bin].map(path => mkdir(path)))

// Source publication, not an injected Ask store: the real owner route resolves
// this execution from its configured file source without calling First Mate.
const snapshot = join(root, 'snapshot.json')
await writeFile(snapshot, JSON.stringify({
  schema: 'fm-fleet-snapshot.v1', fm_home: home, generated: new Date().toISOString(),
  tasks: [{ id: 'ci-worker', spawn_gen: 'ci-attempt', current_state: { state: 'working' }, backlog: { title: 'Published puller compatibility' } }],
  backlog: { present: true, records: [] },
}))
await writeFile(join(config, 'config.json'), JSON.stringify({
  ask: { ownerLogins: [owner], bridgeToken: token },
  firstmate: { homes: [] }, reconciliation: { fleet: [{ home, snapshotFile: snapshot }] },
}))

const reservation = createServer()
await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = (reservation.address() as { port: number }).port
await new Promise<void>(resolve => reservation.close(() => resolve()))
const base = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, [resolve('dist/server/standalone.js'), '--port', String(port), '--host', '127.0.0.1', '--no-open', '--no-reach'], {
  // Deliberately don't inherit credentials, config, proxy variables or PATH.
  env: { HOME: home, PATH: bin, TINSTAR_CONFIG_HOME: config, TINSTAR_TELEMETRY: '0', TINSTAR_NO_PORT_FALLBACK: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
const exited = once(server, 'exit')
let logs = ''
server.stdout.on('data', data => { logs += String(data) })
server.stderr.on('data', data => { logs += String(data) })
server.on('error', error => { logs += String(error) })

const headers = { 'Content-Type': 'application/json', 'Tailscale-User-Login': owner, 'X-Tinstar-UI': '1' }
async function call(path: string, body?: unknown, auth = headers) {
  const response = await fetch(base + path, {
    headers: auth, signal: AbortSignal.timeout(3_000),
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
  })
  const result = await response.json()
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(result)}`)
  assert.equal(result.ok, true)
  return result.data
}

try {
  const deadline = Date.now() + 15_000
  for (;;) {
    assert.equal(server.exitCode, null, `Server exited before startup: ${logs}`)
    try {
      assert.equal((await readFile(join(config, 'server.port'), 'utf8')).trim(), String(port))
      await call('/api/ask/requests')
      break
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await delay(50)
    }
  }
  const scene = await call('/api/reconciliation/scene')
  assert.equal(scene.executions.length, 1)
  const target = { kind: 'execution', id: scene.executions[0].id }
  const proof = await publishedPullerContract({
    root, base, token,
    create: async question => (await call('/api/ask/requests', { client_key: randomUUID(), target, question, view: { scene: 'overview' } })).request_id,
    // This is the same owner API read by the Desk Ask panel.
    list: () => call('/api/ask/requests') as Promise<ReturnType<typeof publicAsk>[]>,
    work: () => call('/api/ask/bridge', undefined, { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }),
  })
  console.log(`Published puller ${proof.version} (${proof.sha256}): ${proof.requests} owner requests verified against built server`)
} catch (error) {
  console.error(logs)
  throw error
} finally {
  server.kill('SIGTERM')
  const killTimer = setTimeout(() => server.kill('SIGKILL'), 3_000)
  await exited
  clearTimeout(killTimer)
  await rm(root, { recursive: true, force: true })
}

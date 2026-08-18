// @vitest-environment node
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connect, StringCodec, type NatsConnection } from 'nats'
import { afterEach, describe, expect, it } from 'vitest'
import type { LiveDeliveryResult } from '../../messaging/live-recipient-resolution'
import {
  deriveMessageRouterSessionKey,
  NatsMessageRouterService,
  type MessageRouteRequest,
} from '../../messaging/message-router'
import { codexMcpLaunchFlags } from '../codex-mcp'
import {
  generateNatsMcpConfig,
  natsControlSocketPath,
  natsOwnerLockPath,
} from '../../sessions/backends/tmux'
import { BASE_CONFIG } from '../../sessions/config'
import { reconnectSessionNats } from '../../sessions/natsReconnect'

const natsServerAvailable = spawnSync('nats-server', ['-v'], { stdio: 'ignore' }).status === 0
const codexAvailable = spawnSync('codex', ['--version'], { stdio: 'ignore' }).status === 0
const bunAvailable = spawnSync(BASE_CONFIG.nats.bunPath, ['--version'], { stdio: 'ignore' }).status === 0
const productionRuntimeAvailable = natsServerAvailable && bunAvailable
if (process.env.TINSTAR_REQUIRE_NATS_CHANNEL_RUNTIME === '1' && !productionRuntimeAvailable) {
  throw new Error('TINSTAR_REQUIRE_NATS_CHANNEL_RUNTIME requires nats-server and the configured Bun runtime')
}
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nats-mcp-runtime.mjs')
const children: ChildProcess[] = []
const connections: NatsConnection[] = []
const roots: string[] = []
const routers: NatsMessageRouterService[] = []

afterEach(async () => {
  for (const router of routers.splice(0)) await router.stop().catch(() => undefined)
  for (const connection of connections.splice(0)) await connection.close().catch(() => undefined)
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test port')
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  })
  return address.port
}

async function connectEventually(url: string): Promise<NatsConnection> {
  let lastError: unknown
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const connection = await connect({
        servers: url,
        maxReconnectAttempts: 0,
        timeout: 250,
      })
      connections.push(connection)
      return connection
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

function readJsonLines<T>(path: string): T[] {
  try {
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as T)
  } catch {
    return []
  }
}

async function waitForLines<T>(path: string, count: number): Promise<T[]> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const lines = readJsonLines<T>(path)
    if (lines.length >= count) return lines
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${count} records in ${path}`)
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(resolve => child.once('exit', () => resolve())),
    new Promise<void>(resolve => setTimeout(resolve, 2_000)),
  ])
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
function processGroupMembers(pgid: number): number[] {
  const result = spawnSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || 'could not inspect process groups')
  return result.stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
    .filter(([, group]) => group === pgid).map(([pid]) => pid!)
}
async function waitForProcessGroupMembers(pgid: number, count: number): Promise<number[]> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const members = processGroupMembers(pgid)
    if (members.length >= count) return members
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${count} members in process group ${pgid}`)
}

function writeNodeX(root: string): string {
  const nodeX = join(root, 'node-x.mjs')
  writeFileSync(nodeX, `#!/usr/bin/env node
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
if (args[0] === 'x') args.shift()
const child = spawn(process.execPath, args, { env: process.env, stdio: 'inherit' })
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => child.kill(signal))
child.once('error', error => { throw error })
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
`)
  chmodSync(nodeX, 0o700)
  return nodeX
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function runBash(command: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{
  code: number | null
  output: string
}> {
  const child = spawn('bash', ['-lc', command], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  child.stdout?.on('data', chunk => { output += String(chunk) })
  child.stderr?.on('data', chunk => { output += String(chunk) })
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`command timed out after ${timeoutMs}ms\n${output}`))
    }, timeoutMs)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', exitCode => {
      clearTimeout(timer)
      resolve(exitCode)
    })
  })
  return { code, output }
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class StdioMcpClient {
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  readonly channelNotifications: Record<string, unknown>[] = []

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => this.consume(String(chunk)))
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'tinstar-boundary-test', version: '1.0.0' },
    })
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })}\n`)
  }

  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timed out waiting for MCP ${method}`))
      }, 10_000)
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    while (true) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line) as {
        id?: number
        method?: string
        params?: Record<string, unknown>
        result?: Record<string, unknown>
        error?: { message?: string }
      }
      if (message.method === 'notifications/claude/channel') {
        this.channelNotifications.push(message.params ?? {})
      }
      if (typeof message.id !== 'number') continue
      const pending = this.pending.get(message.id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? 'MCP request failed'))
      else pending.resolve(message.result ?? {})
    }
  }
}

async function waitForNotificationCount(
  clients: StdioMcpClient[],
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (clients.reduce((total, client) => total + client.channelNotifications.length, 0) >= count) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${count} channel notifications`)
}

function accepted(request: MessageRouteRequest, index: number): LiveDeliveryResult {
  const messageId = `msg-${index}`
  const deliveryId = `${messageId}/d/1`
  const acceptedAt = '2026-08-18T12:00:00.000Z'
  return {
    ok: true,
    destinationKind: 'dm',
    exclusions: [],
    acceptance: {
      accepted: true,
      replayed: false,
      wrote: true,
      details: 'retained',
      receipt: {
        requestId: request.requestId,
        messageId,
        acceptedAt,
        deliveryIds: [deliveryId],
      },
      message: {
        id: messageId,
        requestId: request.requestId,
        requestFingerprint: String(index).padStart(64, '0'),
        acceptedAt,
        sender: request.sender,
        destination: request.destination,
        text: request.text,
        deliveryIds: [deliveryId],
      },
      deliveries: [{
        id: deliveryId,
        messageId,
        recipient: {
          providerId: 'codex',
          sessionId: 'receiver',
          incarnation: 'receiver-v1',
        },
        state: 'pending',
        attempt: 0,
        acceptedAt,
        updatedAt: acceptedAt,
        history: [{ state: 'pending', attempt: 0, at: acceptedAt }],
        historyTruncated: false,
      }],
    },
  }
}

describe.skipIf(!natsServerAvailable)('Codex inherited router with real NATS and MCP', () => {
  it('keeps one inbound subscriber and authenticates replies from parent and child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-codex-router-nats-'))
    roots.push(root)
    const sessionsDir = join(root, 'sessions')
    const launchesPath = join(root, 'launches.jsonl')
    const deliveriesPath = join(root, 'deliveries.jsonl')
    const nodeX = writeNodeX(root)
    const sessionName = `native-boundary-${process.pid}-${Date.now()}`
    const topic = `tinstar.test.${randomUUID()}`
    const destination = `tinstar.test.destination.${randomUUID()}`
    const routerSubject = `_TINSTAR.delivery.route.v1.${randomUUID()}`
    const agentIncarnation = 'parent-v1'
    const authMasterKey = Buffer.alloc(32, 0x51)
    const authKey = deriveMessageRouterSessionKey(authMasterKey, {
      sessionId: sessionName,
      incarnation: agentIncarnation,
    })

    const port = await freePort()
    const natsUrl = `nats://127.0.0.1:${port}`
    const natsServer = spawn('nats-server', ['-a', '127.0.0.1', '-p', String(port)], {
      stdio: 'ignore',
    })
    children.push(natsServer)
    const publisher = await connectEventually(natsUrl)

    const routed: MessageRouteRequest[] = []
    const router = new NatsMessageRouterService({
      subject: routerSubject,
      authMasterKey,
      natsUrl,
      route: async request => {
        routed.push(request)
        return accepted(request, routed.length)
      },
    })
    routers.push(router)
    await router.start()

    const configPath = generateNatsMcpConfig({
      sessionsDir,
      sessionName,
      agentIncarnation,
      nats: { enabled: true, subscriptions: [topic] },
      channelServerPackage: fixturePath,
      bunPath: nodeX,
      jetstream: false,
      natsUrl,
      routerSubject,
      routerAuth: authKey.toString('hex'),
    })
    const descriptor = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers: { nats: { command: string; args: string[]; env: Record<string, string> } }
    }
    const server = descriptor.mcpServers.nats
    server.env.TINSTAR_TEST_LAUNCHES = launchesPath
    server.env.TINSTAR_TEST_DELIVERIES = deliveriesPath
    writeFileSync(configPath, JSON.stringify(descriptor, null, 2), { mode: 0o600 })

    expect(codexMcpLaunchFlags(configPath).join(' ')).toContain('required=true')
    const ownerLock = natsOwnerLockPath(sessionsDir, sessionName)
    const forgedSharedMarker = join(tmpdir(), `tinstar-nats-${sessionName}.owner`)
    roots.push(forgedSharedMarker)
    mkdirSync(forgedSharedMarker)
    writeFileSync(join(forgedSharedMarker, 'owner.json'), JSON.stringify({
      markerId: 'forged',
      launcher: { pid: process.pid },
    }))
    expect(ownerLock.startsWith(join(sessionsDir, sessionName))).toBe(true)
    expect(ownerLock).not.toBe(forgedSharedMarker)

    const launch = (extraEnv: Record<string, string> = {}) => {
      const child = spawn(server.command, server.args, {
        env: { ...process.env, ...server.env, ...extraEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      children.push(child)
      return child
    }

    const parent = launch() as ChildProcessWithoutNullStreams
    const parentMcp = new StdioMcpClient(parent)
    await parentMcp.initialize()
    const child = launch() as ChildProcessWithoutNullStreams
    const childMcp = new StdioMcpClient(child)
    await childMcp.initialize()

    const launches = await waitForLines<{ args: string[]; pid: number; routerAuth: string }>(launchesPath, 2)
    expect(launches.filter(item => item.args.includes('--topics-file'))).toHaveLength(1)
    expect(launches.filter(item => item.args.includes('--control-socket'))).toHaveLength(1)
    expect(launches.filter(item => item.args.includes(natsControlSocketPath(sessionName)))).toHaveLength(1)
    expect(launches.filter(item => item.args.some(arg => arg.startsWith('_TINSTAR.reply-only.')))).toHaveLength(1)

    publisher.publish(topic, StringCodec().encode('one inbound delivery'))
    await publisher.flush()
    const deliveries = await waitForLines<{ pid: number; subject: string; text: string }>(deliveriesPath, 1)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(readJsonLines(deliveriesPath)).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ subject: topic, text: 'one inbound delivery' })

    const parentReply = await parentMcp.request('tools/call', {
      name: 'reply',
      arguments: { to: destination, text: 'parent reply', requestId: 'parent-request' },
    })
    const childReply = await childMcp.request('tools/call', {
      name: 'reply',
      arguments: { to: destination, text: 'child reply', requestId: 'child-request' },
    })
    expect(parentReply).toMatchObject({ structuredContent: { status: 'accepted' } })
    expect(childReply).toMatchObject({ structuredContent: { status: 'accepted' } })
    expect(routed.map(request => request.text)).toEqual(['parent reply', 'child reply'])

    const forged = launch({ TINSTAR_MESSAGE_ROUTER_AUTH: 'b'.repeat(64) }) as ChildProcessWithoutNullStreams
    const forgedMcp = new StdioMcpClient(forged)
    await forgedMcp.initialize()
    const forgedReply = await forgedMcp.request('tools/call', {
      name: 'reply',
      arguments: { to: destination, text: 'forged reply', requestId: 'forged-request' },
    })
    expect(forgedReply).toMatchObject({ isError: true })
    expect(routed.map(request => request.text)).toEqual(['parent reply', 'child reply'])

    await stop(forged)
    await stop(child)
    await stop(parent)
    await reconnectSessionNats(sessionName, { socketPath: natsControlSocketPath(sessionName), ownerLockPath: ownerLock, findPids: async () => [] })
    expect(existsSync(ownerLock)).toBe(false)
    expect(readJsonLines(deliveriesPath)).toHaveLength(1)
  }, 20_000)
})

describe.runIf(productionRuntimeAvailable)('pinned nats-channel-mcp inherited boundary', () => {
  it('keeps the production runtime authoritative after its bunx leader is hard-killed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-pinned-router-nats-'))
    roots.push(root)
    const sessionsDir = join(root, 'sessions')
    const sessionName = `pinned-boundary-${process.pid}-${Date.now()}`
    const topic = `tinstar.pinned.${randomUUID()}`
    const destination = `tinstar.pinned.destination.${randomUUID()}`
    const routerSubject = `_TINSTAR.delivery.route.v1.${randomUUID()}`
    const agentIncarnation = 'pinned-parent-v1'
    const authMasterKey = Buffer.alloc(32, 0x71)
    const authKey = deriveMessageRouterSessionKey(authMasterKey, {
      sessionId: sessionName,
      incarnation: agentIncarnation,
    })

    const port = await freePort()
    const natsUrl = `nats://127.0.0.1:${port}`
    const natsServer = spawn('nats-server', ['-a', '127.0.0.1', '-p', String(port)], {
      stdio: 'ignore',
    })
    children.push(natsServer)
    const publisher = await connectEventually(natsUrl)

    const routed: MessageRouteRequest[] = []
    const router = new NatsMessageRouterService({
      subject: routerSubject,
      authMasterKey,
      natsUrl,
      route: async request => {
        routed.push(request)
        return accepted(request, routed.length)
      },
    })
    routers.push(router)
    await router.start()

    const configPath = generateNatsMcpConfig({
      sessionsDir,
      sessionName,
      agentIncarnation,
      nats: { enabled: true, subscriptions: [topic] },
      channelServerPackage: BASE_CONFIG.nats.channelServerPackage,
      bunPath: BASE_CONFIG.nats.bunPath,
      jetstream: false,
      natsUrl,
      routerSubject,
      routerAuth: authKey.toString('hex'),
    })
    const descriptor = JSON.parse(readFileSync(configPath, 'utf8')) as {
      mcpServers: { nats: { command: string; args: string[]; env: Record<string, string> } }
    }
    const server = descriptor.mcpServers.nats
    const launch = () => {
      const child = spawn(server.command, server.args, {
        env: { ...process.env, ...server.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams
      children.push(child)
      return child
    }

    const parent = launch()
    const parentMcp = new StdioMcpClient(parent)
    await parentMcp.initialize()
    const child = launch()
    const childMcp = new StdioMcpClient(child)
    await childMcp.initialize()

    const parentReply = await parentMcp.request('tools/call', {
      name: 'reply',
      arguments: { to: destination, text: 'pinned parent reply', requestId: 'pinned-parent' },
    })
    const childReply = await childMcp.request('tools/call', {
      name: 'reply',
      arguments: { to: destination, text: 'pinned child reply', requestId: 'pinned-child' },
    })
    expect(parentReply).toMatchObject({ structuredContent: { status: 'accepted' } })
    expect(childReply).toMatchObject({ structuredContent: { status: 'accepted' } })
    expect(routed.map(request => request.text)).toEqual([
      'pinned parent reply',
      'pinned child reply',
    ])

    publisher.publish(topic, StringCodec().encode('one pinned inbound delivery'))
    await publisher.flush()
    await waitForNotificationCount([parentMcp, childMcp], 1)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(parentMcp.channelNotifications).toHaveLength(1)
    expect(childMcp.channelNotifications).toHaveLength(0)

    const ownerLock = natsOwnerLockPath(sessionsDir, sessionName)
    const owner = JSON.parse(readFileSync(join(ownerLock, 'owner.json'), 'utf8')) as { markerId: string }
    const ownerChild = JSON.parse(readFileSync(join(ownerLock, `.child-${owner.markerId}.json`), 'utf8')) as { channelGroup: { pgid: number } }
    const groupLeader = ownerChild.channelGroup.pgid
    const members = await waitForProcessGroupMembers(groupLeader, 2)
    const runtimePid = members.find(pid => pid !== groupLeader)
    expect(runtimePid).toBeTypeOf('number')
    process.kill(groupLeader, 'SIGKILL')
    const leaderDeadline = Date.now() + 2_000
    while (processIsAlive(groupLeader) && Date.now() < leaderDeadline) await new Promise(resolve => setTimeout(resolve, 20))
    expect(processIsAlive(runtimePid!)).toBe(true)

    const contender = launch()
    const contenderMcp = new StdioMcpClient(contender)
    await contenderMcp.initialize()
    const contenderReply = await contenderMcp.request('tools/call', {
      name: 'reply', arguments: { to: destination, text: 'pinned contender reply', requestId: 'pinned-contender' },
    })
    expect(contenderReply).toMatchObject({ structuredContent: { status: 'accepted' } })
    publisher.publish(topic, StringCodec().encode('one delivery after leader death'))
    await publisher.flush()
    await waitForNotificationCount([parentMcp, childMcp, contenderMcp], 2)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(parentMcp.channelNotifications).toHaveLength(2)
    expect(childMcp.channelNotifications).toHaveLength(0)
    expect(contenderMcp.channelNotifications).toHaveLength(0)

    await stop(contender)
    await stop(child)
    await stop(parent)
    await reconnectSessionNats(sessionName, { socketPath: natsControlSocketPath(sessionName), ownerLockPath: ownerLock, findPids: async () => [] })
    expect(existsSync(ownerLock)).toBe(false)
  }, 120_000)
})

const nativeCodexHome = process.env.TINSTAR_NATIVE_CODEX_HOME
const nativeCodexBoundaryAvailable = natsServerAvailable && codexAvailable && Boolean(nativeCodexHome)
if (process.env.TINSTAR_REQUIRE_NATIVE_CODEX_BOUNDARY === '1' && !nativeCodexBoundaryAvailable) {
  throw new Error('TINSTAR_REQUIRE_NATIVE_CODEX_BOUNDARY requires nats-server, Codex, and TINSTAR_NATIVE_CODEX_HOME')
}

describe.runIf(nativeCodexBoundaryAvailable)(
  'native Codex inherited managed-router boundary',
  () => {
    it('starts a required parent MCP and an inherited reply-capable child MCP', async () => {
      const root = mkdtempSync(join(tmpdir(), 'tinstar-native-codex-router-'))
      roots.push(root)
      const sessionsDir = join(root, 'sessions')
      const launchesPath = join(root, 'launches.jsonl')
      const deliveriesPath = join(root, 'deliveries.jsonl')
      const nodeX = writeNodeX(root)
      const sessionName = `native-codex-${process.pid}-${Date.now()}`
      const topic = `tinstar.native.${randomUUID()}`
      const destination = `tinstar.native.destination.${randomUUID()}`
      const routerSubject = `_TINSTAR.delivery.route.v1.${randomUUID()}`
      const agentIncarnation = 'native-parent-v1'
      const authMasterKey = Buffer.alloc(32, 0x61)
      const authKey = deriveMessageRouterSessionKey(authMasterKey, {
        sessionId: sessionName,
        incarnation: agentIncarnation,
      })

      const port = await freePort()
      const natsUrl = `nats://127.0.0.1:${port}`
      const natsServer = spawn('nats-server', ['-a', '127.0.0.1', '-p', String(port)], {
        stdio: 'ignore',
      })
      children.push(natsServer)
      await connectEventually(natsUrl)

      const routed: MessageRouteRequest[] = []
      const router = new NatsMessageRouterService({
        subject: routerSubject,
        authMasterKey,
        natsUrl,
        route: async request => {
          routed.push(request)
          return accepted(request, routed.length)
        },
      })
      routers.push(router)
      await router.start()

      const configPath = generateNatsMcpConfig({
        sessionsDir,
        sessionName,
        agentIncarnation,
        nats: { enabled: true, subscriptions: [topic] },
        channelServerPackage: fixturePath,
        bunPath: nodeX,
        jetstream: false,
        natsUrl,
        routerSubject,
        routerAuth: authKey.toString('hex'),
      })
      const descriptor = JSON.parse(readFileSync(configPath, 'utf8')) as {
        mcpServers: { nats: { command: string; args: string[]; env: Record<string, string> } }
      }
      descriptor.mcpServers.nats.env.TINSTAR_TEST_LAUNCHES = launchesPath
      descriptor.mcpServers.nats.env.TINSTAR_TEST_DELIVERIES = deliveriesPath
      writeFileSync(configPath, JSON.stringify(descriptor, null, 2), { mode: 0o600 })

      const flags = codexMcpLaunchFlags(configPath).join(' ')
      expect(flags).toContain('required=true')
      const prompt = [
        `Call the reply tool once with to=${destination}, text=parent native reply, and requestId=parent-native-request.`,
        'Then use the native spawn_agent tool with fork_turns none to start one child.',
        `Tell that child to call the reply tool once with to=${destination}, text=child native reply, and requestId=child-native-request.`,
        'Wait for the child to finish. Return exactly NATIVE_BOUNDARY_OK only after both reply calls succeed.',
      ].join(' ')
      const command = [
        'codex exec --sandbox read-only --enable multi_agent',
        '-c mcp_servers.atlassian.enabled=false',
        flags,
        shellQuote(prompt),
      ].join(' ')
      const native = await runBash(command, {
        ...process.env,
        ...descriptor.mcpServers.nats.env,
        CODEX_HOME: nativeCodexHome,
      }, 240_000)
      expect(native.code, native.output).toBe(0)
      expect(native.output).toContain('NATIVE_BOUNDARY_OK')
      expect(new Set(routed.map(request => request.text))).toEqual(new Set([
        'parent native reply',
        'child native reply',
      ]))

      const launches = await waitForLines<{ args: string[]; pid: number }>(launchesPath, 2)
      const ownerLaunches = launches.filter(item => item.args.includes('--topics-file'))
      const followerLaunches = launches.filter(
        item => item.args.some(arg => arg.startsWith('_TINSTAR.reply-only.')),
      )
      expect(ownerLaunches).toHaveLength(1)
      expect(followerLaunches.length)
        .toBeGreaterThanOrEqual(1)
      const parentRoute = routed.find(request => request.text === 'parent native reply')
      const childRoute = routed.find(request => request.text === 'child native reply')
      expect(parentRoute?.requestId).toBe(`${ownerLaunches[0]!.pid}:parent-native-request`)
      expect(followerLaunches.map(item => `${item.pid}:child-native-request`))
        .toContain(childRoute?.requestId)

      const brokenConfigPath = join(root, 'broken-required-mcp.json')
      const brokenDescriptor = structuredClone(descriptor)
      brokenDescriptor.mcpServers.nats.command = process.execPath
      brokenDescriptor.mcpServers.nats.args = ['-e', 'process.exit(17)']
      writeFileSync(brokenConfigPath, JSON.stringify(brokenDescriptor, null, 2), { mode: 0o600 })
      const brokenFlags = codexMcpLaunchFlags(brokenConfigPath).join(' ')
      const broken = await runBash([
        'codex exec --sandbox read-only',
        '-c mcp_servers.atlassian.enabled=false',
        brokenFlags,
        shellQuote('Return BROKEN_MCP_SHOULD_NOT_RUN.'),
      ].join(' '), {
        ...process.env,
        ...brokenDescriptor.mcpServers.nats.env,
        CODEX_HOME: nativeCodexHome,
      }, 60_000)
      expect(broken.code).not.toBe(0)
      expect(broken.output).toContain('required MCP servers failed to initialize')
    }, 320_000)
  },
)

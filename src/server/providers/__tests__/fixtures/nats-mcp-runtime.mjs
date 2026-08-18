#!/usr/bin/env node

// Protocol-capable test double for the pinned nats-channel-mcp. It uses a real
// NATS connection and the real Tinstar router wire contract, while keeping the
// fixture independent of Bun and model behavior for the default test suite.

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { connect, StringCodec } from 'nats'

const args = process.argv.slice(2)
const value = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : fallback
}

const natsUrl = value('--nats', 'nats://127.0.0.1:4222')
const topics = []
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--subscribe' && args[index + 1]) topics.push(args[index + 1])
}
const topicsFile = value('--topics-file')
if (topicsFile) {
  for (const line of readFileSync(topicsFile, 'utf8').split('\n')) {
    const topic = line.trim()
    if (topic && !topic.startsWith('#')) topics.push(topic)
  }
}

const launchesPath = process.env.TINSTAR_TEST_LAUNCHES
const deliveriesPath = process.env.TINSTAR_TEST_DELIVERIES
if (!launchesPath || !deliveriesPath) throw new Error('missing Tinstar test event paths')

const sender = {
  sessionId: process.env.TINSTAR_SESSION_NAME,
  incarnation: process.env.TINSTAR_AGENT_INCARNATION,
}
const routerSubject = process.env.TINSTAR_MESSAGE_ROUTER_SUBJECT
const routerAuth = process.env.TINSTAR_MESSAGE_ROUTER_AUTH
if (!sender.sessionId || !sender.incarnation || !routerSubject || !routerAuth) {
  throw new Error('incomplete managed router environment')
}

const nc = await connect({ servers: natsUrl, maxReconnectAttempts: 0, timeout: 1_000 })
const codec = StringCodec()

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

for (const topic of topics) {
  const subscription = nc.subscribe(topic)
  ;(async () => {
    for await (const message of subscription) {
      const text = codec.decode(message.data)
      appendFileSync(deliveriesPath, `${JSON.stringify({ pid: process.pid, subject: message.subject, text })}\n`)
      writeMessage({
        jsonrpc: '2.0',
        method: 'notifications/claude/channel',
        params: { content: text, meta: { subject: message.subject, from: message.reply ?? '' } },
      })
    }
  })()
}
await nc.flush()
appendFileSync(launchesPath, `${JSON.stringify({
  args: process.argv.slice(2),
  pid: process.pid,
  routerAuth,
})}\n`)

function authenticate(payload, key) {
  return createHmac('sha256', key).update(JSON.stringify(payload), 'utf8').digest('hex')
}

function authenticated(payload, key) {
  return { payload, auth: authenticate(payload, key) }
}

function responseIsAuthenticated(response, key) {
  if (!response || typeof response !== 'object' || typeof response.auth !== 'string') return false
  const expected = Buffer.from(authenticate(response.payload, key), 'hex')
  const received = /^[0-9a-f]{64}$/.test(response.auth)
    ? Buffer.from(response.auth, 'hex')
    : Buffer.alloc(expected.length)
  return timingSafeEqual(expected, received)
}

async function callReply(input) {
  const request = {
    version: 1,
    // Attribute every routed request to the exact MCP process that issued it.
    // This lets the native Codex boundary test prove the child reply came from
    // the inherited reply-only server rather than being mimicked by the parent.
    requestId: `${process.pid}:${typeof input.requestId === 'string' ? input.requestId : randomUUID()}`,
    sender,
    destination: { subject: input.to },
    text: input.text,
  }
  const key = Buffer.from(routerAuth, 'hex')
  try {
    const message = await nc.request(
      routerSubject,
      Buffer.from(JSON.stringify(authenticated(request, key))),
      { timeout: 2_000 },
    )
    const response = JSON.parse(codec.decode(message.data))
    if (!responseIsAuthenticated(response, key)) throw new Error('router response authentication failed')
    const result = response.payload
    return {
      ...(result.status === 'error' ? { isError: true } : {}),
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    }
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
    }
  }
}

async function handle(message) {
  if (!Object.hasOwn(message, 'id')) return
  if (message.method === 'initialize') {
    return {
      protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'tinstar-nats-boundary-fixture', version: '1.0.0' },
      instructions: 'Use reply for managed messages.',
    }
  }
  if (message.method === 'tools/list') {
    return {
      tools: [{
        name: 'reply',
        description: 'Route one authenticated Tinstar message.',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string' },
            text: { type: 'string' },
            requestId: { type: 'string' },
          },
          required: ['to', 'text'],
        },
      }],
    }
  }
  if (message.method === 'tools/call' && message.params?.name === 'reply') {
    return callReply(message.params.arguments ?? {})
  }
  throw new Error(`unsupported MCP method ${String(message.method)}`)
}

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
  while (true) {
    const newline = input.indexOf('\n')
    if (newline < 0) break
    const line = input.slice(0, newline).trim()
    input = input.slice(newline + 1)
    if (!line) continue
    const message = JSON.parse(line)
    Promise.resolve(handle(message)).then(
      result => {
        if (Object.hasOwn(message, 'id')) writeMessage({ jsonrpc: '2.0', id: message.id, result })
      },
      error => writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
      }),
    )
  }
})

async function shutdown() {
  await nc.close()
  process.exit(0)
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

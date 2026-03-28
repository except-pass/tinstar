#!/usr/bin/env bun
/**
 * NATS Channel Server — MCP bridge that subscribes to NATS subjects and
 * delivers messages into a Claude Code session as <channel> tags.
 *
 * Usage:
 *   bun channel-server.ts --name a1 --subscribe agents.a1 [--nats nats://localhost:4222]
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { connect, StringCodec, headers } from 'nats'

// ── CLI args ──────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)

function arg(flag: string, fallback?: string): string {
  const i = args.indexOf(flag)
  if (i !== -1 && args[i + 1]) return args[i + 1]!
  if (fallback !== undefined) return fallback
  console.error(`Missing required argument: ${flag}`)
  process.exit(1)
}

function argOptional(flag: string): string | undefined {
  const i = args.indexOf(flag)
  if (i !== -1 && args[i + 1]) return args[i + 1]!
  return undefined
}

const agentName = arg('--name')
const natsUrl   = arg('--nats', 'nats://localhost:4222')

// Collect all --subscribe values (repeatable)
const initialSubjects: string[] = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--subscribe' && args[i + 1]) {
    initialSubjects.push(args[i + 1]!)
  }
}

// --topics-file: one subject per line, # = comment, blank lines ignored
const topicsFile = argOptional('--topics-file')
if (topicsFile) {
  try {
    const lines = readFileSync(topicsFile, 'utf-8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#')) initialSubjects.push(trimmed)
    }
    console.error(`[${agentName}] loaded topics from ${topicsFile}: ${initialSubjects.join(', ')}`)
  } catch (e) {
    console.error(`[${agentName}] error reading --topics-file: ${e}`)
    process.exit(1)
  }
}

if (initialSubjects.length === 0) {
  console.error(`[${agentName}] error: at least one --subscribe subject or --topics-file is required`)
  process.exit(1)
}

// Instructions: --instructions-file takes precedence over --instructions.
// If neither is given, a minimal default is used (customize this).
const instructionsFile = argOptional('--instructions-file')
const defaultInstructions =
  `You are agent ${agentName}. ` +
  `Messages arrive as <channel source="nats" subject="..."> tags. ` +
  `Read each message and act on it. ` +
  `To send a message to another agent or signal completion, ` +
  `use the "reply" tool: reply(to="<nats-subject>", text="<message>").`

let instructions: string
if (instructionsFile) {
  try {
    instructions = readFileSync(instructionsFile, 'utf-8').trim()
    console.error(`[${agentName}] loaded instructions from ${instructionsFile}`)
  } catch (e) {
    console.error(`[${agentName}] error reading --instructions-file: ${e}`)
    process.exit(1)
  }
} else {
  instructions = arg('--instructions', defaultInstructions)
}

// ── NATS connection ───────────────────────────────────────────────────────────

const nc = await connect({ servers: natsUrl })
const sc = StringCodec()

// Track active subscriptions so we can hot-manage them later
const activeSubs = new Map<string, ReturnType<typeof nc.subscribe>>()

// ── Traffic event publishing ──────────────────────────────────────────────────

interface TrafficEvent {
  direction: 'inbound' | 'outbound'
  subject: string
  from: string
  replyTo: string | null
  body: string
}

function publishTrafficEvent(event: TrafficEvent): void {
  nc.publish(
    `_tinstar.traffic.${agentName}`,
    sc.encode(JSON.stringify({
      timestamp: new Date().toISOString(),
      sessionName: agentName,
      direction: event.direction,
      subject: event.subject,
      from: event.from,
      replyTo: event.replyTo,
      body: event.body,
    }))
  )
}

// ── MCP server ────────────────────────────────────────────────────────────────

const mcp = new Server(
  { name: `nats-channel-${agentName}`, version: '0.1.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions,
  }
)

// Reply tool — Claude calls this to publish back to NATS
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Publish a message to a NATS subject',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to:   { type: 'string', description: 'NATS subject to publish to' },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'reply') throw new Error(`unknown tool: ${req.params.name}`)
  const { to, text } = req.params.arguments as { to: string; text: string }

  // Include x-from header so recipients know who sent the message
  const hdrs = headers()
  hdrs.set('x-from', agentName)

  nc.publish(to, sc.encode(text), { headers: hdrs })
  console.error(`[${agentName}] published to ${to}: ${text.slice(0, 80)}`)

  // Publish traffic event for monitoring
  publishTrafficEvent({
    direction: 'outbound',
    subject: to,
    from: agentName,
    replyTo: null,
    body: text,
  })

  return { content: [{ type: 'text' as const, text: `published to ${to}` }] }
})

// ── Subscribe to a NATS subject and bridge to Claude ─────────────────────────

async function subscribe(subject: string): Promise<void> {
  if (activeSubs.has(subject)) return  // already subscribed
  const sub = nc.subscribe(subject)
  activeSubs.set(subject, sub)
  console.error(`[${agentName}] subscribed to ${subject}`)

  ;(async () => {
    for await (const msg of sub) {
      const rawContent = sc.decode(msg.data)

      // Extract metadata for envelope
      const fromHeader = msg.headers?.get('x-from') ?? 'unknown'
      const replyTo = msg.reply ?? 'none'
      const subject = msg.subject

      // Wrap message in metadata envelope
      const content = `--- incoming message ---
from:     ${fromHeader}
replyTo:  ${replyTo}
subject:  ${subject}
---
${rawContent}`

      console.error(`[${agentName}] received on ${msg.subject} from ${fromHeader}: ${rawContent.slice(0, 80)}`)

      // Publish traffic event for monitoring
      publishTrafficEvent({
        direction: 'inbound',
        subject: msg.subject,
        from: fromHeader,
        replyTo: msg.reply ?? null,
        body: rawContent,
      })

      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content,
          meta: {
            subject:  msg.subject,
            from:     fromHeader,
          },
        },
      })
    }
  })()
}

function unsubscribe(subject: string): void {
  const sub = activeSubs.get(subject)
  if (sub) {
    sub.unsubscribe()
    activeSubs.delete(subject)
    console.error(`[${agentName}] unsubscribed from ${subject}`)
  }
}

// ── Connect to Claude Code over stdio (must happen before subscribing) ────────

await mcp.connect(new StdioServerTransport())

// Start with all initial subscriptions
for (const subject of initialSubjects) {
  await subscribe(subject)
}

// ── Unix socket for hot subscription management ───────────────────────────────

import { createServer as createUnixServer, type Socket } from 'node:net'
import { unlinkSync } from 'node:fs'

const socketPath = `/tmp/tinstar-nats-${agentName}.sock`

// Clean up stale socket if it exists
try { unlinkSync(socketPath) } catch { /* doesn't exist */ }

const unixServer = createUnixServer((socket: Socket) => {
  let buffer = ''
  socket.on('data', (data) => {
    buffer += data.toString()
    // Process newline-delimited JSON commands
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''  // Keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const cmd = JSON.parse(line)
        if (cmd.action === 'subscribe' && cmd.subject) {
          subscribe(cmd.subject)
        } else if (cmd.action === 'unsubscribe' && cmd.subject) {
          unsubscribe(cmd.subject)
        } else {
          console.error(`[${agentName}] unknown socket command:`, cmd)
        }
      } catch (e) {
        console.error(`[${agentName}] socket parse error:`, e)
      }
    }
  })
})

unixServer.listen(socketPath, () => {
  console.error(`[${agentName}] listening on socket ${socketPath}`)
})

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
  console.error(`[${agentName}] shutting down`)
  unixServer.close()
  try { unlinkSync(socketPath) } catch { /* already gone */ }
  for (const sub of activeSubs.values()) sub.unsubscribe()
  await nc.drain()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)

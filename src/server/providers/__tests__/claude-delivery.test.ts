import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClaudeChannelControlError,
  authenticatedClaudeChannelDelivery,
  createClaudeDeliveryAdapter,
  requestClaudeChannelDelivery,
  type ClaudeChannelDeliveryCommand,
} from '../claude-delivery'
import { defineProviderDeliveryAdapter, type ProviderDeliveryRequest } from '../contract'

const KEY = Buffer.from('23'.repeat(32), 'hex')
const CHECKED_AT = '2026-08-01T12:00:01.000Z'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function request(): ProviderDeliveryRequest {
  return {
    messageId: 'msg-7',
    deliveryId: 'msg-7/d/1',
    attempt: 1,
    acceptedAt: '2026-08-01T12:00:00.000Z',
    sender: { sessionId: 'sender', incarnation: 'sender-v2' },
    destination: { subject: 'tinstar.space.init.epic.task.receiver' },
    recipient: {
      providerId: 'claude',
      sessionId: 'receiver',
      incarnation: 'receiver-v3',
    },
    text: 'hello once',
  }
}

describe('Claude channel delivery adapter', () => {
  it('waits for a correlated newline receipt from the real Unix socket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-delivery-control-'))
    roots.push(root)
    const socketPath = join(root, 'channel.sock')
    const command: ClaudeChannelDeliveryCommand = {
      action: 'deliver',
      envelope: authenticatedClaudeChannelDelivery(request(), KEY),
    }
    const server = createServer(socket => {
      let data = ''
      socket.on('data', chunk => {
        data += chunk.toString('utf8')
        if (!data.includes('\n')) return
        expect(JSON.parse(data.trim())).toEqual(command)
        socket.write(`${JSON.stringify({
          version: 1,
          status: 'accepted',
          messageId: 'msg-7',
          deliveryId: 'msg-7/d/1',
          attempt: 1,
          recipient: request().recipient,
          acceptedAt: CHECKED_AT,
        })}\n`)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      await expect(requestClaudeChannelDelivery(socketPath, command)).resolves.toMatchObject({
        status: 'accepted', deliveryId: 'msg-7/d/1', acceptedAt: CHECKED_AT,
      })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('sends one authenticated router-stamped envelope to the recipient socket', async () => {
    const seen: Array<{ socket: string; command: ClaudeChannelDeliveryCommand }> = []
    const adapter = defineProviderDeliveryAdapter('claude', createClaudeDeliveryAdapter({
      authKeyFor: () => KEY,
      socketPathFor: sessionId => `/control/${sessionId}.sock`,
      deliver: async (socket, command) => {
        seen.push({ socket, command })
        return {
          version: 1,
          status: 'accepted',
          messageId: command.envelope.payload.messageId,
          deliveryId: command.envelope.payload.deliveryId,
          attempt: command.envelope.payload.attempt,
          recipient: command.envelope.payload.recipient,
          acceptedAt: CHECKED_AT,
        }
      },
    }))

    await expect(adapter.accept(request())).resolves.toMatchObject({
      state: 'delivered',
      providerId: 'claude',
      messageId: 'msg-7',
      attempt: 1,
      deliveredAt: CHECKED_AT,
      evidence: {
        source: { id: 'claude-channel-receipt', label: 'Claude channel receipt' },
        reference: 'msg-7/d/1',
      },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.socket).toBe('/control/receiver.sock')
    expect(seen[0]?.command.envelope.payload).toEqual({ version: 1, ...request() })
    expect(seen[0]?.command.envelope.auth).toBe(createHmac('sha256', KEY)
      .update(JSON.stringify(seen[0]!.command.envelope.payload), 'utf8')
      .digest('hex'))
  })

  it('returns a retryable rejection when no live control socket accepted the command', async () => {
    const adapter = defineProviderDeliveryAdapter('claude', createClaudeDeliveryAdapter({
      authKeyFor: () => KEY,
      deliver: async () => {
        throw new ClaudeChannelControlError('unavailable', 'socket missing', false)
      },
      now: () => CHECKED_AT,
    }))

    await expect(adapter.accept(request())).resolves.toMatchObject({
      state: 'rejected',
      checkedAt: CHECKED_AT,
      reason: 'socket missing',
      retryable: true,
    })
  })

  it('keeps an incarnation replacement terminal for the originally accepted recipient', async () => {
    const adapter = defineProviderDeliveryAdapter('claude', createClaudeDeliveryAdapter({
      authKeyFor: () => KEY,
      deliver: async (_socket, command) => ({
        version: 1,
        status: 'rejected',
        messageId: command.envelope.payload.messageId,
        deliveryId: command.envelope.payload.deliveryId,
        attempt: command.envelope.payload.attempt,
        recipient: command.envelope.payload.recipient,
        checkedAt: CHECKED_AT,
        reason: 'delivery recipient was replaced',
        retryable: false,
      }),
    }))

    await expect(adapter.accept(request())).resolves.toMatchObject({
      state: 'rejected',
      checkedAt: CHECKED_AT,
      reason: 'delivery recipient was replaced',
      retryable: false,
      recipient: request().recipient,
    })
  })

  it('keeps a lost acknowledgement ambiguous after the command may have arrived', async () => {
    const adapter = defineProviderDeliveryAdapter('claude', createClaudeDeliveryAdapter({
      authKeyFor: () => KEY,
      deliver: async () => {
        throw new ClaudeChannelControlError('timeout', 'ack timeout', true)
      },
    }))

    await expect(adapter.accept(request())).rejects.toMatchObject({
      code: 'timeout',
      commandMayHaveArrived: true,
    })
  })

  it('rejects an unstamped request before invoking provider code', async () => {
    const deliver = vi.fn()
    const adapter = defineProviderDeliveryAdapter('claude', createClaudeDeliveryAdapter({
      authKeyFor: () => KEY,
      deliver,
    }))
    const incomplete = { ...request(), destination: undefined }

    await expect(adapter.accept(incomplete as unknown as ProviderDeliveryRequest))
      .rejects.toThrow('not router-stamped: destination subject must not be empty')
    expect(deliver).not.toHaveBeenCalled()
  })
})

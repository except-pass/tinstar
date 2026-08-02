import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  CODEX_MESSAGE_ENVELOPE_MARKER,
  CodexDeliveryAdapter,
  classifyCodexTerminalSafety,
  parseCodexMessageEnvelope,
} from '../codex-delivery'
import type { ProviderDeliveryRequest } from '../contract'
import { findCodexUserMessage } from '../../sessions/codex-transcript'

const NOW = '2026-08-01T12:00:00.000Z'

function request(overrides: Partial<ProviderDeliveryRequest> = {}): ProviderDeliveryRequest {
  return {
    messageId: 'msg-01JABC',
    attempt: 2,
    acceptedAt: '2026-08-01T11:59:59.000Z',
    senderSessionId: 'sender-one',
    recipient: { providerId: 'codex', sessionId: 'worker-two' },
    text: 'Please inspect the failing test.',
    ...overrides,
  }
}

function deps(screen = '• Working (3s)\n\n› Add a follow-up\n  ? for shortcuts') {
  return {
    now: () => NOW,
    captureScreen: vi.fn<(sessionId: string) => Promise<string>>(async () => screen),
    sendPrompt: vi.fn<(sessionId: string, prompt: string) => Promise<void>>(async () => undefined),
    resolveTranscript: vi.fn<(sessionId: string) => Promise<string | null>>(async () => null),
  }
}

describe('Codex terminal delivery', () => {
  it.each([
    'Would you like to run the following command?\n1. Yes\n2. No\nPress enter to confirm or esc to cancel',
    'Select an option\n› 1. Keep changes\n  2. Revert changes\nUse arrow keys, then press enter',
    'Select Model and Effort\n› 1. gpt-5.4 high\n  2. gpt-5.4 medium\nEnter to select · Esc to close',
    'Do you want to run this command?\n› 1. Yes, proceed\n  2. No, go back\nEnter to confirm · Esc to cancel',
    'Pasted text (2,418 chars)\nPress enter to submit or esc to cancel',
    '› 1. Keep changes\n  2. Revert changes',
    'shell$ ',
  ])('treats unsafe or unknown terminal state as non-deliverable', (screen) => {
    expect(classifyCodexTerminalSafety(screen).state).toBe('unsafe')
  })

  it('recognizes the normal Codex composer during an active turn', () => {
    expect(classifyCodexTerminalSafety(
      '• Working (3s)\n\n› Add a follow-up\n  ? for shortcuts',
    )).toEqual({ state: 'safe' })
  })

  it('queues without pressing Enter in an unsafe modal, then delivers the same attempt', async () => {
    const d = deps('Would you like to run this command?\nPress enter to confirm or esc to cancel')
    const adapter = new CodexDeliveryAdapter(d)

    const deferred = await adapter.accept(request())

    expect(deferred).toMatchObject({
      state: 'deferred',
      providerId: 'codex',
      messageId: 'msg-01JABC',
      attempt: 2,
    })
    expect(adapter.queueDepth('worker-two')).toBe(1)
    expect(d.sendPrompt).not.toHaveBeenCalled()

    d.captureScreen.mockResolvedValue('• Working\n\n› Add a follow-up\n  ? for shortcuts')
    const accepted = await adapter.accept(request())

    expect(accepted).toMatchObject({
      state: 'accepted',
      attemptRef: 'tinstar-message-v1:msg-01JABC:2',
    })
    expect(adapter.queueDepth('worker-two')).toBe(0)
    expect(d.sendPrompt).toHaveBeenCalledTimes(1)
    const prompt = d.sendPrompt.mock.calls[0]![1]
    expect(prompt.startsWith(`${CODEX_MESSAGE_ENVELOPE_MARKER}\n`)).toBe(true)
    expect(parseCodexMessageEnvelope(prompt)).toEqual({
      schema: 'tinstar.message.v1',
      message_id: 'msg-01JABC',
      attempt: 2,
      accepted_at: '2026-08-01T11:59:59.000Z',
      sender_session_id: 'sender-one',
      recipient: { provider_id: 'codex', session_id: 'worker-two' },
      text: 'Please inspect the failing test.',
    })
  })

  it('keeps per-recipient delivery FIFO while an earlier attempt is queued', async () => {
    const d = deps('permission required\nPress enter to confirm or esc to cancel')
    const adapter = new CodexDeliveryAdapter(d)
    await adapter.accept(request())

    d.captureScreen.mockResolvedValue('› Add a follow-up\n  ? for shortcuts')
    const later = await adapter.accept(request({ messageId: 'msg-later', attempt: 1 }))

    expect(later).toMatchObject({ state: 'deferred' })
    expect(d.sendPrompt).not.toHaveBeenCalled()
    expect(adapter.queueDepth('worker-two')).toBe(2)

    await adapter.accept(request())
    await adapter.accept(request({ messageId: 'msg-later', attempt: 1 }))
    expect(d.sendPrompt).toHaveBeenCalledTimes(2)
  })

  it('removes a rejected head so the next durable retry can be delivered', async () => {
    const d = deps()
    d.sendPrompt
      .mockRejectedValueOnce(new Error('tmux pane disappeared'))
      .mockResolvedValueOnce(undefined)
    const adapter = new CodexDeliveryAdapter(d)

    const rejected = await adapter.accept(request({ attempt: 1 }))

    expect(rejected).toMatchObject({
      state: 'rejected',
      attempt: 1,
      retryable: true,
      reason: 'Codex prompt injection failed: tmux pane disappeared',
    })
    expect(adapter.queueDepth('worker-two')).toBe(0)

    const accepted = await adapter.accept(request({ attempt: 2 }))

    expect(accepted).toMatchObject({
      state: 'accepted',
      attempt: 2,
      attemptRef: 'tinstar-message-v1:msg-01JABC:2',
    })
    expect(adapter.queueDepth('worker-two')).toBe(0)
    expect(d.sendPrompt).toHaveBeenCalledTimes(2)
    expect(parseCodexMessageEnvelope(d.sendPrompt.mock.calls[1]![1])).toMatchObject({
      message_id: 'msg-01JABC',
      attempt: 2,
    })
  })

  it('discards a deferred queue when the session name is reused by a new incarnation', async () => {
    const d = deps('permission required\nPress enter to confirm or esc to cancel')
    const adapter = new CodexDeliveryAdapter(d)

    const oldAttempt = await adapter.accept(request({
      recipient: {
        providerId: 'codex',
        sessionId: 'worker-two',
        incarnation: 'worker-two-v1',
      },
    }))
    expect(oldAttempt).toMatchObject({ state: 'deferred' })
    expect(adapter.queueDepth('worker-two')).toBe(1)

    d.captureScreen.mockResolvedValue('› Add a follow-up\n  ? for shortcuts')
    const replacement = await adapter.accept(request({
      messageId: 'msg-replacement',
      attempt: 1,
      recipient: {
        providerId: 'codex',
        sessionId: 'worker-two',
        incarnation: 'worker-two-v2',
      },
    }))

    expect(replacement).toMatchObject({ state: 'accepted' })
    expect(adapter.queueDepth('worker-two')).toBe(0)
    expect(d.sendPrompt).toHaveBeenCalledTimes(1)
    expect(parseCodexMessageEnvelope(d.sendPrompt.mock.calls[0]![1])).toMatchObject({
      message_id: 'msg-replacement',
      recipient: {
        session_id: 'worker-two',
        incarnation: 'worker-two-v2',
      },
    })
  })

  it('confirms only an exact router envelope recorded as a rollout user_message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-delivery-'))
    const transcript = join(dir, 'rollout.jsonl')
    const d = deps()
    d.resolveTranscript.mockResolvedValue(transcript)
    const adapter = new CodexDeliveryAdapter(d)
    const accepted = await adapter.accept(request({
      recipient: {
        providerId: 'codex',
        sessionId: 'worker-two',
        incarnation: 'worker-two-v2',
      },
    }))
    if (accepted.state !== 'accepted') throw new Error('fixture was not accepted')
    const deliveredPrompt = d.sendPrompt.mock.calls[0]![1]
    writeFileSync(transcript, [
      JSON.stringify({
        timestamp: NOW,
        type: 'event_msg',
        payload: { type: 'user_message', message: `The body mentions ${accepted.messageId}, but is not an envelope.` },
      }),
      '',
    ].join('\n'))

    expect(await adapter.confirm(accepted)).toMatchObject({ state: 'pending' })

    writeFileSync(transcript, [
      JSON.stringify({
        timestamp: NOW,
        type: 'event_msg',
        payload: { type: 'user_message', message: deliveredPrompt },
      }),
      '',
    ].join('\n'))
    expect(await adapter.confirm({
      ...accepted,
      recipient: { ...accepted.recipient, incarnation: 'worker-two-v3' },
    })).toMatchObject({ state: 'pending' })
    expect(await adapter.confirm(accepted)).toMatchObject({
      state: 'confirmed',
      evidence: {
        source: { id: 'codex-rollout-user-message' },
        reference: 'tinstar-message-v1:msg-01JABC:2',
      },
    })
  })

  it('preserves exact user-message evidence across a UTF-8 chunk boundary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-delivery-utf8-'))
    const transcript = join(dir, 'rollout.jsonl')
    const eventFor = (message: string) => JSON.stringify({
      timestamp: NOW,
      type: 'event_msg',
      payload: { type: 'user_message', message },
    })
    const marker = 'é-boundary'
    const probe = eventFor(marker)
    const markerByteOffset = Buffer.byteLength(probe.slice(0, probe.indexOf(marker)))
    const paddingLength = (256 * 1024) - 1 - markerByteOffset
    const expected = `${'x'.repeat(paddingLength)}${marker}`
    const line = eventFor(expected)

    expect(Buffer.byteLength(line.slice(0, line.indexOf('é')))).toBe((256 * 1024) - 1)
    writeFileSync(transcript, `${line}\n`)

    expect(findCodexUserMessage(transcript, message => message === expected)).toEqual({
      message: expected,
      timestamp: NOW,
    })
  })
})

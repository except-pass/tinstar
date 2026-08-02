import { appendFileSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  CODEX_MESSAGE_ENVELOPE_MARKER,
  CodexDeliveryAdapter,
  type CodexSessionInput,
  classifyCodexTerminalSafety,
  parseCodexMessageEnvelope,
} from '../codex-delivery'
import type { ProviderDeliveryRequest } from '../contract'
import {
  findCodexUserMessage,
  scanCodexUserMessages,
} from '../../sessions/codex-transcript'

const NOW = '2026-08-01T12:00:00.000Z'

function request(overrides: Partial<ProviderDeliveryRequest> = {}): ProviderDeliveryRequest {
  return {
    messageId: 'msg-01JABC',
    deliveryId: 'delivery-01JABC',
    attempt: 2,
    acceptedAt: '2026-08-01T11:59:59.000Z',
    sender: { sessionId: 'sender-one', incarnation: 'sender-one-v1' },
    destination: { subject: 'agents.worker-two.inbox' },
    recipient: {
      providerId: 'codex',
      sessionId: 'worker-two',
      incarnation: 'worker-two-v1',
    },
    text: 'Please inspect the failing test.',
    ...overrides,
  }
}

function deps(screen = '• Working (3s)\n\n› Add a follow-up\n  ? for shortcuts') {
  const captureScreen = vi.fn<() => Promise<string>>(async () => screen)
  const submitPrompt = vi.fn<(
    prompt: string,
    beforeEnter: () => Promise<boolean>,
  ) => Promise<boolean>>(async (_prompt, beforeEnter) => beforeEnter())
  return {
    now: () => NOW,
    captureScreen,
    submitPrompt,
    withSessionInput: async <T>(
      _sessionId: string,
      operation: (input: CodexSessionInput) => Promise<T>,
    ): Promise<T> => operation({
      captureScreen,
      submitPrompt,
    }),
    currentIncarnation: vi.fn<(sessionId: string) => Promise<string | null>>(
      async () => 'worker-two-v1',
    ),
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
    expect(d.submitPrompt).not.toHaveBeenCalled()

    d.captureScreen.mockResolvedValue('• Working\n\n› Add a follow-up\n  ? for shortcuts')
    const accepted = await adapter.accept(request())

    expect(accepted).toMatchObject({
      state: 'accepted',
      attemptRef: expect.stringMatching(/^tinstar-message-v1:sha256:[a-f0-9]{64}$/),
    })
    expect(adapter.queueDepth('worker-two')).toBe(0)
    expect(d.submitPrompt).toHaveBeenCalledTimes(1)
    const prompt = d.submitPrompt.mock.calls[0]![0]
    expect(prompt.startsWith(`${CODEX_MESSAGE_ENVELOPE_MARKER}\n`)).toBe(true)
    expect(parseCodexMessageEnvelope(prompt)).toEqual({
      schema: 'tinstar.message.v1',
      message_id: 'msg-01JABC',
      delivery_id: 'delivery-01JABC',
      attempt: 2,
      accepted_at: '2026-08-01T11:59:59.000Z',
      sender: { session_id: 'sender-one', incarnation: 'sender-one-v1' },
      destination: { subject: 'agents.worker-two.inbox' },
      recipient: {
        provider_id: 'codex',
        session_id: 'worker-two',
        incarnation: 'worker-two-v1',
      },
      text: 'Please inspect the failing test.',
    })
  })

  it('replaces a deferred logical delivery in place when the durable attempt advances', async () => {
    const d = deps('Would you like to run this command?\nPress enter to confirm or esc to cancel')
    const adapter = new CodexDeliveryAdapter(d)

    await expect(adapter.accept(request({ attempt: 1 }))).resolves.toMatchObject({
      state: 'deferred',
      attempt: 1,
    })
    expect(adapter.queueDepth('worker-two')).toBe(1)

    d.captureScreen.mockResolvedValue('• Working\n\n› Add a follow-up\n  ? for shortcuts')
    await expect(adapter.accept(request({ attempt: 2 }))).resolves.toMatchObject({
      state: 'accepted',
      attempt: 2,
    })

    expect(adapter.queueDepth('worker-two')).toBe(0)
    expect(d.submitPrompt).toHaveBeenCalledTimes(1)
    expect(parseCodexMessageEnvelope(d.submitPrompt.mock.calls[0]![0])).toMatchObject({
      message_id: 'msg-01JABC',
      delivery_id: 'delivery-01JABC',
      attempt: 2,
    })
  })

  it('keeps per-recipient delivery FIFO while an earlier attempt is queued', async () => {
    const d = deps('permission required\nPress enter to confirm or esc to cancel')
    const adapter = new CodexDeliveryAdapter(d)
    await adapter.accept(request())

    d.captureScreen.mockResolvedValue('› Add a follow-up\n  ? for shortcuts')
    const later = await adapter.accept(request({
      messageId: 'msg-later',
      deliveryId: 'delivery-later',
      attempt: 1,
    }))

    expect(later).toMatchObject({ state: 'deferred' })
    expect(d.submitPrompt).not.toHaveBeenCalled()
    expect(adapter.queueDepth('worker-two')).toBe(2)

    await adapter.accept(request({ attempt: 3 }))
    await adapter.accept(request({
      messageId: 'msg-later',
      deliveryId: 'delivery-later',
      attempt: 2,
    }))
    expect(d.submitPrompt).toHaveBeenCalledTimes(2)
  })

  it('fails closed when a modal appears at the Enter boundary', async () => {
    const d = deps()
    d.captureScreen
      .mockResolvedValueOnce('› Add a follow-up\n  ? for shortcuts')
      .mockResolvedValueOnce('Would you like to run this command?\nPress enter to confirm')
    const adapter = new CodexDeliveryAdapter(d)

    const result = await adapter.accept(request())

    expect(result).toMatchObject({
      state: 'deferred',
      reason: 'Codex is waiting for a modal confirmation',
    })
    expect(d.submitPrompt).toHaveBeenCalledTimes(1)
    expect(adapter.queueDepth('worker-two')).toBe(1)
  })

  it('treats a failed prompt submission as non-retryable because text may remain', async () => {
    const d = deps()
    d.submitPrompt.mockRejectedValueOnce(new Error('Enter failed after paste'))
    const adapter = new CodexDeliveryAdapter(d)

    const rejected = await adapter.accept(request({ attempt: 1 }))

    expect(rejected).toMatchObject({
      state: 'rejected',
      attempt: 1,
      retryable: false,
      reason: 'Codex prompt submission may have partially failed: Enter failed after paste',
    })
    expect(adapter.queueDepth('worker-two')).toBe(0)
    expect(d.submitPrompt).toHaveBeenCalledOnce()
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
    d.currentIncarnation.mockResolvedValue('worker-two-v2')
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
    expect(d.submitPrompt).toHaveBeenCalledTimes(1)
    expect(parseCodexMessageEnvelope(d.submitPrompt.mock.calls[0]![0])).toMatchObject({
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
    d.currentIncarnation.mockResolvedValue('worker-two-v2')
    const adapter = new CodexDeliveryAdapter(d)
    const accepted = await adapter.accept(request({
      recipient: {
        providerId: 'codex',
        sessionId: 'worker-two',
        incarnation: 'worker-two-v2',
      },
    }))
    if (accepted.state !== 'accepted') throw new Error('fixture was not accepted')
    const deliveredPrompt = d.submitPrompt.mock.calls[0]![0]
    appendFileSync(transcript, [
      JSON.stringify({
        timestamp: NOW,
        type: 'event_msg',
        payload: { type: 'user_message', message: `The body mentions ${accepted.messageId}, but is not an envelope.` },
      }),
      '',
    ].join('\n'))

    expect(await adapter.confirm(accepted)).toMatchObject({ state: 'pending' })

    const envelope = parseCodexMessageEnvelope(deliveredPrompt)
    if (!envelope) throw new Error('fixture prompt was not an envelope')
    const corruptions = [
      { ...envelope, text: 'forged text' },
      { ...envelope, accepted_at: '2026-08-01T00:00:00.000Z' },
      { ...envelope, sender: { ...envelope.sender, incarnation: 'forged-sender' } },
      { ...envelope, destination: { subject: 'agents.someone-else.inbox' } },
      { ...envelope, recipient: { ...envelope.recipient, incarnation: 'forged-recipient' } },
    ]
    for (const corrupted of corruptions) {
      appendFileSync(transcript, `${JSON.stringify({
        timestamp: NOW,
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: `${CODEX_MESSAGE_ENVELOPE_MARKER}\n${JSON.stringify(corrupted)}`,
        },
      })}\n`)
      expect(await adapter.confirm(accepted)).toMatchObject({ state: 'pending' })
    }

    appendFileSync(transcript, [
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
    })).toMatchObject({
      state: 'failed',
      retryable: false,
      reason: 'The accepted Codex recipient process has been replaced or stopped',
    })
    d.currentIncarnation.mockResolvedValue(null)
    expect(await adapter.confirm(accepted)).toMatchObject({
      state: 'confirmed',
      evidence: {
        source: { id: 'codex-rollout-user-message' },
        reference: accepted.attemptRef,
      },
    })
    expect(d.resolveTranscript).toHaveBeenCalledTimes(2)
  })

  it('re-resolves an unverified rollout when same-workdir discovery first picks another session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-delivery-shared-workdir-'))
    const wrongTranscript = join(dir, 'wrong-session.jsonl')
    const correctTranscript = join(dir, 'worker-two.jsonl')
    const d = deps()
    let now = Date.parse(NOW)
    d.now = () => new Date(now).toISOString()
    d.resolveTranscript
      .mockResolvedValueOnce(wrongTranscript)
      .mockResolvedValueOnce(correctTranscript)
    d.currentIncarnation.mockResolvedValue('worker-two-v2')
    const adapter = new CodexDeliveryAdapter(d)
    const accepted = await adapter.accept(request({
      recipient: {
        providerId: 'codex',
        sessionId: 'worker-two',
        incarnation: 'worker-two-v2',
      },
    }))
    if (accepted.state !== 'accepted') throw new Error('fixture was not accepted')
    const deliveredPrompt = d.submitPrompt.mock.calls[0]![0]
    writeFileSync(wrongTranscript, `${JSON.stringify({
      timestamp: NOW,
      type: 'event_msg',
      payload: { type: 'user_message', message: 'another session in this worktree' },
    })}\n`)
    writeFileSync(correctTranscript, `${JSON.stringify({
      timestamp: NOW,
      type: 'event_msg',
      payload: { type: 'user_message', message: deliveredPrompt },
    })}\n`)

    await expect(adapter.confirm(accepted)).resolves.toMatchObject({ state: 'pending' })
    now += 5_000
    await expect(adapter.confirm(accepted)).resolves.toMatchObject({ state: 'confirmed' })
    expect(d.resolveTranscript).toHaveBeenCalledTimes(2)
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

  it('incrementally scans appended records without skipping an incomplete trailing record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-delivery-incremental-'))
    const transcript = join(dir, 'rollout.jsonl')
    const eventFor = (message: string) => JSON.stringify({
      timestamp: NOW,
      type: 'event_msg',
      payload: { type: 'user_message', message },
    })
    writeFileSync(transcript, `${eventFor('older message')}\n`)

    const first = await scanCodexUserMessages(transcript, 0, message => message === 'target')
    expect(first).toMatchObject({ available: true, evidence: null })

    const target = eventFor('target')
    const split = Math.floor(target.length / 2)
    appendFileSync(transcript, target.slice(0, split))
    const incomplete = await scanCodexUserMessages(
      transcript,
      first.nextOffset,
      message => message === 'target',
      first.identity!,
    )
    expect(incomplete).toMatchObject({
      available: true,
      evidence: null,
      nextOffset: first.nextOffset,
    })

    appendFileSync(transcript, `${target.slice(split)}\n`)
    await expect(scanCodexUserMessages(
      transcript,
      incomplete.nextOffset,
      message => message === 'target',
      incomplete.identity!,
    )).resolves.toMatchObject({
      available: true,
      evidence: { message: 'target', timestamp: NOW },
    })
  })

  it('restarts an incremental scan when the transcript identity changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-delivery-rotation-'))
    const transcript = join(dir, 'rollout.jsonl')
    const eventFor = (message: string) => JSON.stringify({
      timestamp: NOW,
      type: 'event_msg',
      payload: { type: 'user_message', message },
    })
    writeFileSync(transcript, `${eventFor('old')}\n`)
    const first = await scanCodexUserMessages(transcript, 0, message => message === 'target')
    renameSync(transcript, join(dir, 'rollout.previous.jsonl'))
    writeFileSync(
      transcript,
      `${eventFor('target with enough padding to exceed the old offset')}\n`,
    )

    await expect(scanCodexUserMessages(
      transcript,
      first.nextOffset,
      message => message.startsWith('target'),
      first.identity!,
    )).resolves.toMatchObject({
      available: true,
      evidence: { message: 'target with enough padding to exceed the old offset' },
    })
  })
})

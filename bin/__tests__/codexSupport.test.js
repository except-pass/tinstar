import { describe, expect, it } from 'vitest'
import {
  MIN_SUPPORTED_CODEX_VERSION,
  compareVersions,
  parseCodexVersion,
  unconfirmedAcceptedFailures,
} from '../codexSupport.js'

describe('parseCodexVersion', () => {
  it('parses `codex --version` output', () => {
    expect(parseCodexVersion('codex-cli 0.147.0')).toBe('0.147.0')
    expect(parseCodexVersion('codex-cli 0.147.0\n')).toBe('0.147.0')
  })

  it('returns null for unrecognized output', () => {
    expect(parseCodexVersion('')).toBeNull()
    expect(parseCodexVersion('command not found')).toBeNull()
    expect(parseCodexVersion(null)).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders numeric segments, not strings', () => {
    expect(compareVersions('0.147.0', '0.146.0')).toBe(1)
    expect(compareVersions('0.146.0', '0.147.0')).toBe(-1)
    expect(compareVersions('0.147.0', '0.147.0')).toBe(0)
    // String comparison would call 0.9 > 0.147; numeric must not.
    expect(compareVersions('0.9.0', '0.147.0')).toBe(-1)
    expect(compareVersions('1.0.0', '0.999.0')).toBe(1)
  })

  it('treats missing segments as zero', () => {
    expect(compareVersions('0.147', '0.147.0')).toBe(0)
  })
})

describe('MIN_SUPPORTED_CODEX_VERSION', () => {
  it('is the first codex version with the current rollout schema', () => {
    expect(MIN_SUPPORTED_CODEX_VERSION).toBe('0.147.0')
  })
})

describe('unconfirmedAcceptedFailures', () => {
  const confirmationExhausted = {
    id: 'msg-a/d/1',
    messageId: 'msg-a',
    recipient: { providerId: 'codex', sessionId: 's', incarnation: 'i' },
    state: 'failed',
    attempt: 3,
    history: [
      { state: 'accepted', attempt: 0, at: '2026-08-11T19:46:18.632Z' },
      {
        state: 'failed',
        attempt: 3,
        reason: 'Provider delivery could not be confirmed after 3 attempts: Codex rollout has not recorded this message as user input',
        retryable: false,
        at: '2026-08-11T20:03:00.074Z',
      },
    ],
  }
  const recipientReplaced = {
    ...confirmationExhausted,
    id: 'msg-b/d/1',
    history: [
      confirmationExhausted.history[0],
      {
        state: 'failed',
        attempt: 1,
        reason: 'The accepted Codex recipient process has been replaced or stopped',
        retryable: false,
        at: '2026-08-11T20:03:00.074Z',
      },
    ],
  }
  const delivered = { ...confirmationExhausted, id: 'msg-c/d/1', state: 'delivered' }
  const retryableFailure = {
    ...confirmationExhausted,
    id: 'msg-d/d/1',
    history: [
      confirmationExhausted.history[0],
      {
        state: 'failed',
        attempt: 1,
        reason: 'Provider delivery acceptance remained unobservable: Codex rollout is not available yet',
        retryable: true,
        at: '2026-08-11T20:03:00.074Z',
      },
    ],
  }

  it('flags only terminal confirmation-exhausted failures', () => {
    const flagged = unconfirmedAcceptedFailures([
      confirmationExhausted,
      recipientReplaced,
      delivered,
      retryableFailure,
    ])
    expect(flagged.map(delivery => delivery.id)).toEqual(['msg-a/d/1'])
  })

  it('tolerates malformed delivery records', () => {
    expect(unconfirmedAcceptedFailures([null, {}, { state: 'failed' }])).toEqual([])
    expect(unconfirmedAcceptedFailures(undefined)).toEqual([])
  })
})

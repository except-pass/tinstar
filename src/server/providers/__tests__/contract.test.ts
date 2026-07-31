import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  ProviderCapabilities,
  ProviderObservationKind,
  ProviderObservationRequestFor,
  ProviderObservationSnapshotFor,
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
  ProviderScope,
  ProviderTokenUsage,
} from '../../../domain/provider-capabilities'
import {
  defineProviderAdapter,
  ProviderDeliveryIdentityError,
  type ProviderAdapter,
  type ProviderDeliveryAcceptance,
  type ProviderDeliveryConfirmation,
} from '../contract'

interface ForgeDetail {
  region: string
  sequence?: number
}

const CHECKED_AT = '2026-07-30T12:00:01.000Z'
const OBSERVED_AT = '2026-07-30T12:00:00.000Z'

const capabilities = {
  observations: {
    'session-usage': {
      state: 'supported',
      detail: {
        sources: [{ id: 'local-journal', label: 'Local journal' }],
        region: 'workstation',
      },
    },
    'session-context': {
      state: 'supported',
      detail: {
        sources: [{ id: 'local-journal', label: 'Local journal' }],
        region: 'workstation',
      },
    },
    'provider-quota': {
      state: 'supported',
      detail: {
        sources: [{ id: 'account-window', label: 'Account window' }],
        region: 'account',
      },
    },
    'historical-telemetry': {
      state: 'unsupported',
      reason: 'This provider exposes current observations only',
    },
    'context-breakdown': {
      state: 'unsupported',
      reason: 'The native source has no category breakdown',
    },
  },
  delivery: {
    acceptance: {
      state: 'supported',
      detail: {
        transports: [{ id: 'terminal-input', kind: 'terminal', label: 'Terminal input' }],
        timing: ['next-boundary'],
        region: 'workstation',
      },
    },
    confirmation: {
      state: 'supported',
      detail: {
        evidence: [{ id: 'journal-message', label: 'Journal message' }],
        region: 'workstation',
      },
    },
  },
} satisfies ProviderCapabilities<ForgeDetail>

function unsupportedSnapshot<
  K extends ProviderObservationKind,
  TDetail extends object,
>(
  providerId: string,
  request: ProviderObservationRequestFor<K>,
  reason: string,
  detail: TDetail,
): ProviderObservationSnapshotFor<K, TDetail> {
  return {
    kind: request.kind,
    providerId,
    scope: request.scope,
    source: null,
    freshness: {
      state: 'unknown',
      observedAt: null,
      checkedAt: CHECKED_AT,
    },
    availability: {
      state: 'unsupported',
      reason,
    },
    detail,
  }
}

function notObserved<
  K extends 'session-context' | 'provider-quota',
>(
  request: ProviderObservationRequestFor<K>,
): ProviderObservationSnapshotFor<K, ForgeDetail> {
  const capability = capabilities.observations[request.kind]
  if (capability.state !== 'supported') {
    throw new Error(`${request.kind} must be supported by this fixture`)
  }
  return {
    kind: request.kind,
    providerId: 'forge',
    scope: request.scope,
    source: capability.detail.sources[0] ?? null,
    freshness: {
      state: 'unknown',
      observedAt: null,
      checkedAt: CHECKED_AT,
    },
    availability: {
      state: 'unavailable',
      reason: 'not-observed',
    },
    detail: { region: 'workstation' },
  }
}

const forge = defineProviderAdapter<ForgeDetail>({
  provider: {
    id: 'forge',
    label: 'Forge CLI',
  },
  sessionLifecycle: 'terminal',
  capabilities,
  observe: {
    async 'session-usage'(request) {
      return {
        kind: request.kind,
        providerId: 'forge',
        scope: request.scope,
        source: { id: 'local-journal', label: 'Local journal' },
        freshness: {
          state: 'fresh',
          observedAt: OBSERVED_AT,
          checkedAt: CHECKED_AT,
          staleAfterMs: 5_000,
        },
        availability: {
          state: 'available',
          value: {
            model: 'forge-large',
            cumulativeTokens: {
              input: 8,
              output: 5,
              total: 13,
            },
            latestTurnTokens: {
              input: 3,
              output: 2,
              total: 5,
            },
          },
        },
        detail: { region: 'workstation', sequence: 9 },
      }
    },
    async 'session-context'(request) {
      return notObserved(request)
    },
    async 'provider-quota'(request) {
      return notObserved(request)
    },
    async 'historical-telemetry'(request) {
      const capability = capabilities.observations[request.kind]
      return unsupportedSnapshot(
        'forge',
        request,
        capability.state === 'unsupported' ? capability.reason : 'Unexpected support state',
        { region: 'workstation' },
      )
    },
    async 'context-breakdown'(request) {
      const capability = capabilities.observations[request.kind]
      return unsupportedSnapshot(
        'forge',
        request,
        capability.state === 'unsupported' ? capability.reason : 'Unexpected support state',
        { region: 'workstation' },
      )
    },
  },
  delivery: {
    async accept(request) {
      return {
        state: 'accepted',
        providerId: 'forge',
        messageId: request.messageId,
        attempt: request.attempt,
        recipient: request.recipient,
        acceptedAt: CHECKED_AT,
        attemptRef: `forge:${request.messageId}:${request.attempt}`,
        detail: { region: 'workstation', sequence: request.attempt },
      }
    },
    async confirm(acceptance) {
      return {
        state: 'confirmed',
        providerId: 'forge',
        messageId: acceptance.messageId,
        attempt: acceptance.attempt,
        recipient: acceptance.recipient,
        confirmedAt: CHECKED_AT,
        evidence: {
          source: { id: 'journal-message', label: 'Journal message' },
          reference: acceptance.attemptRef,
        },
        detail: { region: 'workstation', sequence: acceptance.attempt },
      }
    },
  },
})

describe('provider capability contract', () => {
  it('accepts a fake third provider without a closed provider registry', async () => {
    const adapter: ProviderAdapter = forge
    const registry = new Map<string, ProviderAdapter>([
      [forge.provider.id, forge],
    ])
    const snapshot = await adapter.observe['session-usage']({
      kind: 'session-usage',
      scope: { kind: 'session', sessionId: 'run-forge' },
    })

    expect(adapter.provider).toEqual({ id: 'forge', label: 'Forge CLI' })
    expect(registry.get('forge')?.provider.id).toBe('forge')
    expect(adapter.sessionLifecycle).toBe('terminal')
    expect(snapshot).toMatchObject({
      kind: 'session-usage',
      providerId: 'forge',
      scope: { kind: 'session', sessionId: 'run-forge' },
      source: { id: 'local-journal' },
      freshness: { state: 'fresh', observedAt: OBSERVED_AT },
      availability: {
        state: 'available',
        value: {
          cumulativeTokens: { total: 13 },
          latestTurnTokens: { total: 5 },
        },
      },
      detail: { region: 'workstation', sequence: 9 },
    })
  })

  it('makes unsupported observations explicit instead of returning null or zero', async () => {
    const snapshot = await forge.observe['context-breakdown']({
      kind: 'context-breakdown',
      scope: { kind: 'session', sessionId: 'run-forge' },
    })

    expect(snapshot.source).toBeNull()
    expect(snapshot.freshness).toEqual({
      state: 'unknown',
      observedAt: null,
      checkedAt: CHECKED_AT,
    })
    expect(snapshot.availability).toEqual({
      state: 'unsupported',
      reason: 'The native source has no category breakdown',
    })
  })

  it('allows a capability-light provider to reject delivery explicitly', async () => {
    const unsupported = { state: 'unsupported', reason: 'Observation is not exposed' } as const
    const observer = defineProviderAdapter({
      provider: { id: 'observer', label: 'Observer CLI' },
      sessionLifecycle: 'terminal',
      capabilities: {
        observations: {
          'session-usage': unsupported,
          'session-context': unsupported,
          'provider-quota': unsupported,
          'historical-telemetry': unsupported,
          'context-breakdown': unsupported,
        },
        delivery: {
          acceptance: { state: 'unsupported', reason: 'This CLI is read-only' },
          confirmation: { state: 'unsupported', reason: 'No messages are accepted' },
        },
      },
      observe: {
        async 'session-usage'(request) {
          return unsupportedSnapshot('observer', request, unsupported.reason, {})
        },
        async 'session-context'(request) {
          return unsupportedSnapshot('observer', request, unsupported.reason, {})
        },
        async 'provider-quota'(request) {
          return unsupportedSnapshot('observer', request, unsupported.reason, {})
        },
        async 'historical-telemetry'(request) {
          return unsupportedSnapshot('observer', request, unsupported.reason, {})
        },
        async 'context-breakdown'(request) {
          return unsupportedSnapshot('observer', request, unsupported.reason, {})
        },
      },
      delivery: null,
    })

    const snapshot = await observer.observe['provider-quota']({
      kind: 'provider-quota',
      scope: { kind: 'provider', accountRef: 'default' },
    })

    expect(observer.delivery).toBeNull()
    expect(observer.capabilities.delivery.acceptance).toEqual({
      state: 'unsupported',
      reason: 'This CLI is read-only',
    })
    expect(snapshot.availability.state).toBe('unsupported')
  })

  it('scopes quota to one provider and keeps zero utilization available', () => {
    expectTypeOf<{ kind: 'provider' }>().not.toMatchTypeOf<ProviderScope>()
    expectTypeOf<{}>().not.toMatchTypeOf<ProviderTokenUsage>()

    const quota = {
      kind: 'provider-quota',
      providerId: 'forge',
      scope: { kind: 'provider', accountRef: 'default' },
      source: { id: 'account-window', label: 'Account window' },
      freshness: {
        state: 'fresh',
        observedAt: OBSERVED_AT,
        checkedAt: CHECKED_AT,
      },
      availability: {
        state: 'available',
        value: {
          windows: [{
            id: 'burst',
            label: 'Burst window',
            windowMinutes: 300,
            usedPercent: 0,
            resetsAt: '2026-07-30T13:00:00.000Z',
          }],
        },
      },
      detail: { region: 'account' },
    } satisfies ProviderQuotaSnapshot<ForgeDetail>

    expect(quota.availability.value.windows[0]?.usedPercent).toBe(0)
    expect(quota.availability.value.windows[0]?.windowMinutes).toBe(300)
  })

  it('preserves arbitrary provider-native quota window durations', () => {
    const windows = [
      {
        id: 'primary',
        label: 'Primary window',
        windowMinutes: 10_080,
        usedPercent: 40,
      },
      {
        id: 'secondary',
        label: 'Secondary window',
        windowMinutes: 300,
        usedPercent: 8.5,
      },
    ] satisfies readonly ProviderQuotaWindow[]

    expect(windows.map((window) => window.windowMinutes)).toEqual([10_080, 300])
  })

  it('represents acceptance-only delivery without fabricating confirmation', async () => {
    const unsupported = {
      state: 'unsupported',
      reason: 'Boundary exposes delivery only',
    } as const
    const acceptanceOnly = defineProviderAdapter({
      provider: { id: 'boundary', label: 'Boundary CLI' },
      sessionLifecycle: 'terminal',
      capabilities: {
        observations: {
          'session-usage': unsupported,
          'session-context': unsupported,
          'provider-quota': unsupported,
          'historical-telemetry': unsupported,
          'context-breakdown': unsupported,
        },
        delivery: {
          acceptance: {
            state: 'supported',
            detail: {
              transports: [{
                id: 'terminal-input',
                kind: 'terminal',
                label: 'Terminal input',
              }],
              timing: ['next-boundary'],
            },
          },
          confirmation: {
            state: 'unsupported',
            reason: 'The terminal exposes no delivery receipt',
          },
        },
      },
      observe: {
        async 'session-usage'(request) {
          return unsupportedSnapshot('boundary', request, unsupported.reason, {})
        },
        async 'session-context'(request) {
          return unsupportedSnapshot('boundary', request, unsupported.reason, {})
        },
        async 'provider-quota'(request) {
          return unsupportedSnapshot('boundary', request, unsupported.reason, {})
        },
        async 'historical-telemetry'(request) {
          return unsupportedSnapshot('boundary', request, unsupported.reason, {})
        },
        async 'context-breakdown'(request) {
          return unsupportedSnapshot('boundary', request, unsupported.reason, {})
        },
      },
      delivery: {
        async accept(request) {
          return {
            state: 'accepted',
            providerId: 'boundary',
            messageId: request.messageId,
            attempt: request.attempt,
            recipient: request.recipient,
            acceptedAt: CHECKED_AT,
          }
        },
      },
    })

    const acceptance = await acceptanceOnly.delivery!.accept({
      messageId: 'msg-boundary',
      attempt: 1,
      acceptedAt: CHECKED_AT,
      senderSessionId: 'run-sender',
      recipient: { providerId: 'boundary', sessionId: 'run-boundary' },
      text: 'Queued?',
    })

    expect(acceptance).toMatchObject({
      state: 'accepted',
      messageId: 'msg-boundary',
      attempt: 1,
    })
    expect(acceptanceOnly.delivery).not.toHaveProperty('confirm')
  })

  it('represents deferred, rejected, pending, and failed delivery outcomes', () => {
    const acceptances = [
      {
        state: 'deferred',
        providerId: 'forge',
        messageId: 'msg-retry',
        attempt: 1,
        recipient: { providerId: 'forge', sessionId: 'run-forge' },
        checkedAt: CHECKED_AT,
        reason: 'Recipient is between prompt boundaries',
        retryAt: '2026-07-30T12:00:02.000Z',
      },
      {
        state: 'rejected',
        providerId: 'forge',
        messageId: 'msg-stopped',
        attempt: 1,
        recipient: { providerId: 'forge', sessionId: 'run-forge' },
        checkedAt: CHECKED_AT,
        reason: 'Recipient is not live',
        retryable: false,
      },
    ] satisfies ProviderDeliveryAcceptance[]
    const confirmations = [
      {
        state: 'pending',
        providerId: 'forge',
        messageId: 'msg-retry',
        attempt: 2,
        recipient: { providerId: 'forge', sessionId: 'run-forge' },
        checkedAt: CHECKED_AT,
        reason: 'No provider evidence yet',
        retryAt: '2026-07-30T12:00:03.000Z',
      },
      {
        state: 'failed',
        providerId: 'forge',
        messageId: 'msg-retry',
        attempt: 2,
        recipient: { providerId: 'forge', sessionId: 'run-forge' },
        checkedAt: CHECKED_AT,
        reason: 'Provider rejected the attempt',
        retryable: true,
      },
    ] satisfies ProviderDeliveryConfirmation[]

    expect(acceptances.map((result) => result.state)).toEqual(['deferred', 'rejected'])
    expect(confirmations.map((result) => result.state)).toEqual(['pending', 'failed'])
  })

  it('keeps router acceptance separate from final-mile acceptance and confirmation', async () => {
    const request = {
      messageId: 'msg-7a51',
      attempt: 2,
      acceptedAt: '2026-07-30T11:59:59.000Z',
      senderSessionId: 'run-sender',
      recipient: {
        providerId: 'forge',
        sessionId: 'run-forge',
      },
      text: 'Status?',
    }

    const acceptance = await forge.delivery!.accept(request)
    expect(acceptance).toMatchObject({
      state: 'accepted',
      providerId: 'forge',
      messageId: 'msg-7a51',
      attempt: 2,
      recipient: request.recipient,
    })
    if (acceptance.state !== 'accepted') throw new Error('expected accepted delivery attempt')

    const delivery = forge.delivery
    if (!delivery?.confirm) throw new Error('expected confirmation-capable delivery')
    const confirmation = await delivery.confirm(acceptance)
    expect(confirmation).toMatchObject({
      state: 'confirmed',
      providerId: 'forge',
      messageId: 'msg-7a51',
      attempt: 2,
      recipient: request.recipient,
      evidence: {
        source: { id: 'journal-message' },
        reference: 'forge:msg-7a51:2',
      },
    })
  })

  it('rejects delivery implementations that contradict declared capabilities', () => {
    const delivery = forge.delivery
    if (!delivery?.confirm) throw new Error('expected confirmation-capable delivery')

    expect(() => defineProviderAdapter({
      ...forge,
      delivery: null,
    })).toThrow('acceptance is supported')

    expect(() => defineProviderAdapter({
      ...forge,
      capabilities: {
        ...forge.capabilities,
        delivery: {
          acceptance: {
            state: 'unsupported',
            reason: 'This provider is read-only',
          },
          confirmation: {
            state: 'unsupported',
            reason: 'No messages are accepted',
          },
        },
      },
    })).toThrow('acceptance is unsupported')

    expect(() => defineProviderAdapter({
      ...forge,
      delivery: {
        accept: delivery.accept,
      },
    })).toThrow('confirmation is supported')

    expect(() => defineProviderAdapter({
      ...forge,
      capabilities: {
        ...forge.capabilities,
        delivery: {
          ...forge.capabilities.delivery,
          confirmation: {
            state: 'unsupported',
            reason: 'No evidence is exposed',
          },
        },
      },
    })).toThrow('confirmation is unsupported')
  })

  it('rejects observation results that contradict declared capabilities', async () => {
    const inconsistent = defineProviderAdapter({
      ...forge,
      capabilities: {
        ...forge.capabilities,
        observations: {
          ...forge.capabilities.observations,
          'session-usage': {
            state: 'unsupported',
            reason: 'Usage is disabled',
          },
        },
      },
    })

    await expect(inconsistent.observe['session-usage']({
      kind: 'session-usage',
      scope: { kind: 'session', sessionId: 'run-forge' },
    })).rejects.toThrow('observation "session-usage" is declared unsupported')
  })

  it('allows supported observations to be temporarily unavailable', async () => {
    await expect(forge.observe['provider-quota']({
      kind: 'provider-quota',
      scope: { kind: 'provider', accountRef: 'default' },
    })).resolves.toMatchObject({
      providerId: 'forge',
      availability: {
        state: 'unavailable',
        reason: 'not-observed',
      },
    })
  })

  it('rejects snapshots attributed to the wrong provider', async () => {
    const misidentified = defineProviderAdapter({
      ...forge,
      observe: {
        ...forge.observe,
        async 'session-usage'(request) {
          return {
            ...await forge.observe['session-usage'](request),
            providerId: 'someone-else',
          }
        },
      },
    })

    await expect(misidentified.observe['session-usage']({
      kind: 'session-usage',
      scope: { kind: 'session', sessionId: 'run-forge' },
    })).rejects.toThrow('returned providerId "someone-else"')
  })

  it('rejects snapshots with the wrong kind or scope', async () => {
    const wrongKind = defineProviderAdapter({
      ...forge,
      observe: {
        ...forge.observe,
        async 'session-usage'(request) {
          const snapshot = await forge.observe['session-usage'](request)
          Reflect.set(snapshot, 'kind', 'provider-quota')
          return snapshot
        },
      },
    })
    const wrongScope = defineProviderAdapter({
      ...forge,
      observe: {
        ...forge.observe,
        async 'session-usage'(request) {
          return {
            ...await forge.observe['session-usage'](request),
            scope: { kind: 'session', sessionId: 'some-other-run' },
          }
        },
      },
    })
    const request = {
      kind: 'session-usage',
      scope: { kind: 'session', sessionId: 'run-forge' },
    } as const

    await expect(wrongKind.observe['session-usage'](request))
      .rejects.toThrow('returned kind "provider-quota"')
    await expect(wrongScope.observe['session-usage'](request))
      .rejects.toThrow('scope that does not match the request')
  })

  it('rejects delivery results that change the stable message identity', async () => {
    const delivery = forge.delivery
    if (!delivery?.confirm) throw new Error('expected confirmation-capable delivery')
    const mismatched = defineProviderAdapter({
      ...forge,
      delivery: {
        async accept(request) {
          return {
            ...await delivery.accept(request),
            messageId: 'some-other-message',
          }
        },
        async confirm(acceptance) {
          return {
            ...await delivery.confirm(acceptance),
            attempt: acceptance.attempt + 1,
          }
        },
      },
    })
    const request = {
      messageId: 'msg-stable',
      attempt: 3,
      acceptedAt: CHECKED_AT,
      senderSessionId: 'run-sender',
      recipient: { providerId: 'forge', sessionId: 'run-forge' },
      text: 'Still there?',
    }

    const mismatchedAcceptance = mismatched.delivery!.accept(request)
    await expect(mismatchedAcceptance)
      .rejects.toThrow('returned messageId "some-other-message"')
    await expect(mismatchedAcceptance).rejects.toBeInstanceOf(ProviderDeliveryIdentityError)
    await expect(mismatchedAcceptance).rejects.toMatchObject({
      sideEffectMayHaveOccurred: true,
      result: {
        state: 'accepted',
        providerId: 'forge',
        messageId: 'some-other-message',
        attempt: 3,
        attemptRef: 'forge:msg-stable:3',
      },
      expected: {
        providerId: 'forge',
        messageId: 'msg-stable',
        attempt: 3,
      },
    })

    const acceptance = await delivery.accept(request)
    if (acceptance.state !== 'accepted') throw new Error('expected accepted delivery attempt')
    const confirming = mismatched.delivery
    if (!confirming?.confirm) throw new Error('expected confirmation-capable delivery')
    const mismatchedConfirmation = confirming.confirm(acceptance)
    await expect(mismatchedConfirmation)
      .rejects.toThrow('returned attempt 4')
    await expect(mismatchedConfirmation).rejects.toBeInstanceOf(ProviderDeliveryIdentityError)
    await expect(mismatchedConfirmation).rejects.toMatchObject({
      sideEffectMayHaveOccurred: false,
      expected: {
        providerId: 'forge',
        messageId: 'msg-stable',
        attempt: 3,
      },
    })
  })

  it('treats every malformed acceptance as possibly delivered after adapter invocation', async () => {
    const delivery = forge.delivery
    if (!delivery) throw new Error('expected delivery adapter')
    const mismatched = defineProviderAdapter({
      ...forge,
      delivery: {
        ...delivery,
        async accept(request) {
          return {
            state: 'rejected',
            providerId: 'boundary',
            messageId: request.messageId,
            attempt: request.attempt,
            recipient: request.recipient,
            checkedAt: CHECKED_AT,
            reason: 'Stale provider result',
            retryable: true,
          }
        },
      },
    })
    const request = {
      messageId: 'msg-conservative-retry',
      attempt: 1,
      acceptedAt: CHECKED_AT,
      senderSessionId: 'run-sender',
      recipient: { providerId: 'forge', sessionId: 'run-forge' },
      text: 'Do not duplicate me',
    }

    const result = mismatched.delivery!.accept(request)
    await expect(result).rejects.toThrow('returned providerId "boundary"')
    await expect(result).rejects.toMatchObject({
      sideEffectMayHaveOccurred: true,
      result: {
        state: 'rejected',
        providerId: 'boundary',
      },
    })
  })

  it('rejects recipient-session drift across acceptance and confirmation', async () => {
    const delivery = forge.delivery
    if (!delivery?.confirm) throw new Error('expected confirmation-capable delivery')
    const wrongAcceptanceRecipient = defineProviderAdapter({
      ...forge,
      delivery: {
        ...delivery,
        async accept(request) {
          return {
            ...await delivery.accept(request),
            recipient: {
              ...request.recipient,
              sessionId: 'run-someone-else',
            },
          }
        },
      },
    })
    const request = {
      messageId: 'msg-session-bound',
      attempt: 1,
      acceptedAt: CHECKED_AT,
      senderSessionId: 'run-sender',
      recipient: { providerId: 'forge', sessionId: 'run-forge' },
      text: 'Right session?',
    }

    await expect(wrongAcceptanceRecipient.delivery!.accept(request))
      .rejects.toThrow('returned recipient sessionId "run-someone-else"')

    const acceptance = await delivery.accept(request)
    if (acceptance.state !== 'accepted') throw new Error('expected accepted delivery attempt')
    const wrongConfirmationRecipient = defineProviderAdapter({
      ...forge,
      delivery: {
        ...delivery,
        async confirm(candidate) {
          return {
            ...await delivery.confirm!(candidate),
            recipient: {
              ...candidate.recipient,
              sessionId: 'run-someone-else',
            },
          }
        },
      },
    })
    const confirming = wrongConfirmationRecipient.delivery
    if (!confirming?.confirm) throw new Error('expected confirmation-capable delivery')

    await expect(confirming.confirm(acceptance))
      .rejects.toThrow('returned recipient sessionId "run-someone-else"')
  })

  it('rejects a delivery for another provider before invoking the adapter', async () => {
    let acceptCalls = 0
    const delivery = forge.delivery
    if (!delivery) throw new Error('expected delivery adapter')
    const guarded = defineProviderAdapter({
      ...forge,
      delivery: {
        ...delivery,
        async accept(request) {
          acceptCalls += 1
          return delivery.accept(request)
        },
      },
    })

    const misrouted = guarded.delivery!.accept({
      messageId: 'msg-wrong-provider',
      attempt: 1,
      acceptedAt: CHECKED_AT,
      senderSessionId: 'run-sender',
      recipient: { providerId: 'boundary', sessionId: 'run-boundary' },
      text: 'Do not send this',
    })
    await expect(misrouted).rejects.toThrow('addressed to provider "boundary"')
    await expect(misrouted).rejects.toBeInstanceOf(ProviderDeliveryIdentityError)
    await expect(misrouted).rejects.toMatchObject({
      sideEffectMayHaveOccurred: false,
      result: null,
      expected: {
        providerId: 'forge',
        messageId: 'msg-wrong-provider',
        attempt: 1,
      },
    })
    expect(acceptCalls).toBe(0)
  })

  it('rejects confirmation for another provider before invoking the adapter', async () => {
    let confirmCalls = 0
    const delivery = forge.delivery
    if (!delivery?.confirm) throw new Error('expected confirmation-capable delivery')
    const guarded = defineProviderAdapter({
      ...forge,
      delivery: {
        ...delivery,
        async confirm(acceptance) {
          confirmCalls += 1
          return delivery.confirm!(acceptance)
        },
      },
    })
    const acceptance = await delivery.accept({
      messageId: 'msg-cross-provider-confirm',
      attempt: 1,
      acceptedAt: CHECKED_AT,
      senderSessionId: 'run-sender',
      recipient: { providerId: 'forge', sessionId: 'run-forge' },
      text: 'Confirm?',
    })
    if (acceptance.state !== 'accepted') throw new Error('expected accepted delivery attempt')

    const confirming = guarded.delivery
    if (!confirming?.confirm) throw new Error('expected confirmation-capable delivery')
    const misrouted = confirming.confirm({
      ...acceptance,
      providerId: 'boundary',
    })
    await expect(misrouted).rejects.toThrow('belongs to provider "boundary"')
    await expect(misrouted).rejects.toBeInstanceOf(ProviderDeliveryIdentityError)
    await expect(misrouted).rejects.toMatchObject({
      sideEffectMayHaveOccurred: false,
      result: null,
      expected: {
        providerId: 'forge',
        messageId: 'msg-cross-provider-confirm',
        attempt: 1,
      },
    })

    const misroutedRecipient = confirming.confirm({
      ...acceptance,
      recipient: {
        ...acceptance.recipient,
        providerId: 'boundary',
      },
    })
    await expect(misroutedRecipient)
      .rejects.toThrow('belongs to provider "boundary"')
    await expect(misroutedRecipient).rejects.toBeInstanceOf(ProviderDeliveryIdentityError)
    expect(confirmCalls).toBe(0)
  })

  it('rejects a provider quota snapshot for another configured account', async () => {
    const mismatched = defineProviderAdapter({
      ...forge,
      observe: {
        ...forge.observe,
        async 'provider-quota'(request) {
          return {
            ...await forge.observe['provider-quota'](request),
            scope: { kind: 'provider', accountRef: 'some-other-account' },
          }
        },
      },
    })

    await expect(mismatched.observe['provider-quota']({
      kind: 'provider-quota',
      scope: { kind: 'provider', accountRef: 'default' },
    })).rejects.toThrow('scope that does not match the request')
  })

  it('re-registers derived adapters against raw handlers instead of stale guards', async () => {
    const unsupportedUsage = defineProviderAdapter({
      ...forge,
      observe: {
        ...forge.observe,
        async 'session-usage'(request) {
          return unsupportedSnapshot(
            'forge',
            request,
            'Usage is disabled',
            { region: 'workstation' },
          )
        },
      },
    })
    const derived = defineProviderAdapter({
      ...unsupportedUsage,
      capabilities: {
        ...unsupportedUsage.capabilities,
        observations: {
          ...unsupportedUsage.capabilities.observations,
          'session-usage': {
            state: 'unsupported',
            reason: 'Usage is disabled',
          },
        },
      },
    })

    await expect(derived.observe['session-usage']({
      kind: 'session-usage',
      scope: { kind: 'session', sessionId: 'run-forge' },
    })).resolves.toMatchObject({
      providerId: 'forge',
      availability: {
        state: 'unsupported',
        reason: 'Usage is disabled',
      },
    })
  })
})

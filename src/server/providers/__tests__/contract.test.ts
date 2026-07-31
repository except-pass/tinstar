import { describe, expect, it } from 'vitest'
import type {
  ProviderCapabilities,
  ProviderObservationKind,
  ProviderObservationRequestFor,
  ProviderObservationSnapshotFor,
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from '../../../domain/provider-capabilities'
import {
  defineProviderAdapter,
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
        messageId: request.messageId,
        attempt: request.attempt,
        acceptedAt: CHECKED_AT,
        attemptRef: `forge:${request.messageId}:${request.attempt}`,
        detail: { region: 'workstation', sequence: request.attempt },
      }
    },
    async confirm(request, acceptance) {
      return {
        state: 'confirmed',
        messageId: request.messageId,
        attempt: acceptance.attempt,
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
    const snapshot = await adapter.observe['session-usage']({
      kind: 'session-usage',
      scope: { kind: 'session', sessionId: 'run-forge' },
    })

    expect(adapter.provider).toEqual({ id: 'forge', label: 'Forge CLI' })
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
      scope: { kind: 'provider' },
    })

    expect(observer.delivery).toBeNull()
    expect(observer.capabilities.delivery.acceptance).toEqual({
      state: 'unsupported',
      reason: 'This CLI is read-only',
    })
    expect(snapshot.availability.state).toBe('unsupported')
  })

  it('scopes quota to one provider and keeps zero utilization available', () => {
    const quota = {
      kind: 'provider-quota',
      providerId: 'forge',
      scope: { kind: 'provider' },
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

    expect(quota.scope).toEqual({ kind: 'provider' })
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
    const acceptanceOnly = defineProviderAdapter({
      provider: { id: 'boundary', label: 'Boundary CLI' },
      sessionLifecycle: 'terminal',
      capabilities: {
        observations: forge.capabilities.observations,
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
              region: 'workstation',
            },
          },
          confirmation: {
            state: 'unsupported',
            reason: 'The terminal exposes no delivery receipt',
          },
        },
      },
      observe: forge.observe,
      delivery: {
        async accept(request) {
          return {
            state: 'accepted',
            messageId: request.messageId,
            attempt: request.attempt,
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
        messageId: 'msg-retry',
        attempt: 1,
        checkedAt: CHECKED_AT,
        reason: 'Recipient is between prompt boundaries',
        retryAt: '2026-07-30T12:00:02.000Z',
      },
      {
        state: 'rejected',
        messageId: 'msg-stopped',
        attempt: 1,
        checkedAt: CHECKED_AT,
        reason: 'Recipient is not live',
        retryable: false,
      },
    ] satisfies ProviderDeliveryAcceptance[]
    const confirmations = [
      {
        state: 'pending',
        messageId: 'msg-retry',
        attempt: 2,
        checkedAt: CHECKED_AT,
        reason: 'No provider evidence yet',
        retryAt: '2026-07-30T12:00:03.000Z',
      },
      {
        state: 'failed',
        messageId: 'msg-retry',
        attempt: 2,
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
      messageId: 'msg-7a51',
      attempt: 2,
    })
    if (acceptance.state !== 'accepted') throw new Error('expected accepted delivery attempt')

    const delivery = forge.delivery
    if (!delivery?.confirm) throw new Error('expected confirmation-capable delivery')
    const confirmation = await delivery.confirm(request, acceptance)
    expect(confirmation).toMatchObject({
      state: 'confirmed',
      messageId: 'msg-7a51',
      attempt: 2,
      evidence: {
        source: { id: 'journal-message' },
        reference: 'forge:msg-7a51:2',
      },
    })
  })
})

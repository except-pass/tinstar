import { describe, expect, it, vi } from 'vitest'
import type {
  ProviderAccountQuotaObservationWire,
  ProviderSessionContextObservationWire,
  ProviderSessionUsageObservationWire,
} from '../../../domain/provider-observation-wire'
import type { ProviderSessionContext } from '../../../domain/provider-capabilities'
import { ProviderCurrentObservationStores } from '../observation-stores'

// @ts-expect-error available session context requires at least one measurement
const EMPTY_SESSION_CONTEXT: ProviderSessionContext = {}
void EMPTY_SESSION_CONTEXT

const OBSERVED_AT = '2026-08-01T12:00:00.000Z'
const CHECKED_AT = '2026-08-01T12:00:01.000Z'

function sessionUsage(
  providerId: string,
  sessionId: string,
  total: number,
): ProviderSessionUsageObservationWire {
  return {
    kind: 'session-usage',
    providerId,
    scope: { kind: 'session', sessionId },
    source: { id: 'native-events', label: 'Native events' },
    freshness: {
      state: 'fresh',
      observedAt: OBSERVED_AT,
      checkedAt: CHECKED_AT,
      staleAfterMs: 5_000,
    },
    availability: {
      state: 'available',
      value: { cumulativeTokens: { total } },
    },
  }
}

function sessionContext(
  providerId: string,
  sessionId: string,
  usedPercent: number,
): ProviderSessionContextObservationWire {
  return {
    kind: 'session-context',
    providerId,
    scope: { kind: 'session', sessionId },
    source: { id: 'native-events', label: 'Native events' },
    freshness: {
      state: 'fresh',
      observedAt: OBSERVED_AT,
      checkedAt: CHECKED_AT,
    },
    availability: {
      state: 'available',
      value: { usedPercent, windowTokens: 200_000 },
    },
  }
}

function quota(
  providerId: string,
  accountRef: string,
  usedPercent: number,
): ProviderAccountQuotaObservationWire {
  return {
    kind: 'provider-quota',
    providerId,
    scope: { kind: 'provider', accountRef },
    source: { id: 'native-quota', label: 'Native quota' },
    freshness: {
      state: 'fresh',
      observedAt: OBSERVED_AT,
      checkedAt: CHECKED_AT,
    },
    availability: {
      state: 'available',
      value: {
        windows: [{
          id: 'primary',
          label: 'Primary window',
          windowMinutes: 300,
          usedPercent,
        }],
      },
    },
  }
}

describe('ProviderCurrentObservationStores', () => {
  it('keys session usage and context by provider as well as session', () => {
    const stores = new ProviderCurrentObservationStores()

    stores.sessions.setUsage(sessionUsage('claude', 'shared-session', 10))
    stores.sessions.setUsage(sessionUsage('codex', 'shared-session', 20))
    stores.sessions.setContext(sessionContext('claude', 'shared-session', 12))

    expect(stores.sessions.getUsage('claude', 'shared-session'))
      .toMatchObject({ providerId: 'claude', availability: { value: { cumulativeTokens: { total: 10 } } } })
    expect(stores.sessions.getUsage('codex', 'shared-session'))
      .toMatchObject({ providerId: 'codex', availability: { value: { cumulativeTokens: { total: 20 } } } })
    expect(stores.sessions.getContext('codex', 'shared-session')).toBeUndefined()
    expect(stores.sessions.getContext('claude', 'shared-session'))
      .toMatchObject({ availability: { value: { usedPercent: 12 } } })
  })

  it('keeps same-named quota windows separate by provider and account', () => {
    const stores = new ProviderCurrentObservationStores()

    stores.quotas.set(quota('claude', 'default', 15))
    stores.quotas.set(quota('codex', 'default', 72))
    stores.quotas.set(quota('codex', 'work', 31))

    expect(stores.quotas.list()).toHaveLength(3)
    expect(stores.quotas.get('claude', 'default'))
      .toMatchObject({ availability: { value: { windows: [{ id: 'primary', usedPercent: 15 }] } } })
    expect(stores.quotas.get('codex', 'default'))
      .toMatchObject({ availability: { value: { windows: [{ id: 'primary', usedPercent: 72 }] } } })
    expect(stores.quotas.get('codex', 'work'))
      .toMatchObject({ availability: { value: { windows: [{ id: 'primary', usedPercent: 31 }] } } })
  })

  it('derives staleness on read without mutating the producer snapshot', () => {
    let now = Date.parse(CHECKED_AT)
    const stores = new ProviderCurrentObservationStores({ now: () => now })
    const input = sessionUsage('claude', 'session-1', 25)
    stores.sessions.setUsage(input)

    now = Date.parse(OBSERVED_AT) + 5_001

    expect(stores.sessions.getUsage('claude', 'session-1')?.freshness).toEqual({
      state: 'stale',
      observedAt: OBSERVED_AT,
      checkedAt: CHECKED_AT,
      staleSince: '2026-08-01T12:00:05.000Z',
    })
    expect(input.freshness.state).toBe('fresh')
  })

  it('preserves unavailable and unsupported as different stored values', () => {
    const stores = new ProviderCurrentObservationStores()
    stores.sessions.setContext({
      kind: 'session-context',
      providerId: 'claude',
      scope: { kind: 'session', sessionId: 'waiting' },
      source: { id: 'statusline', label: 'Statusline' },
      freshness: { state: 'unknown', observedAt: null, checkedAt: CHECKED_AT },
      availability: { state: 'unavailable', reason: 'not-observed' },
    })
    stores.sessions.setContext({
      kind: 'session-context',
      providerId: 'forge',
      scope: { kind: 'session', sessionId: 'unsupported' },
      source: null,
      freshness: { state: 'unknown', observedAt: null, checkedAt: CHECKED_AT },
      availability: { state: 'unsupported', reason: 'No native context source' },
    })

    expect(stores.sessions.getContext('claude', 'waiting')?.availability.state).toBe('unavailable')
    expect(stores.sessions.getContext('forge', 'unsupported')?.availability.state).toBe('unsupported')
  })

  it('round-trips real store state through the versioned wire schema', () => {
    const stores = new ProviderCurrentObservationStores({ now: () => Date.parse(CHECKED_AT) })
    stores.sessions.setUsage(sessionUsage('claude', 'session-1', 40))
    stores.sessions.setContext(sessionContext('claude', 'session-1', 33))
    stores.quotas.set(quota('claude', 'default', 18))
    stores.quotas.set(quota('codex', 'default', 61))

    const encoded = JSON.stringify(stores.toWire())
    const restored = ProviderCurrentObservationStores.fromWire(
      JSON.parse(encoded),
      { now: () => Date.parse(CHECKED_AT) },
    )

    expect(restored.toWire()).toEqual(stores.toWire())
  })

  it('rejects ambiguous wire values and duplicate quota identities', () => {
    const ambiguous = {
      ...sessionContext('claude', 'session-1', 40),
      source: null,
    }
    expect(() => ProviderCurrentObservationStores.fromWire({
      version: 1,
      sessionUsage: [],
      sessionContext: [ambiguous],
      providerQuota: [],
    })).toThrow()

    const emptyContext = {
      ...sessionContext('claude', 'session-1', 40),
      availability: { state: 'available', value: {} },
    }
    expect(() => ProviderCurrentObservationStores.fromWire({
      version: 1,
      sessionUsage: [],
      sessionContext: [emptyContext],
      providerQuota: [],
    })).toThrow(/at least one/i)

    const duplicate = quota('claude', 'default', 10)
    expect(() => ProviderCurrentObservationStores.fromWire({
      version: 1,
      sessionUsage: [],
      sessionContext: [],
      providerQuota: [duplicate, quota('claude', 'default', 20)],
    })).toThrow(/duplicate/i)
  })

  it('clones reads and skips change notifications for identical writes', () => {
    const stores = new ProviderCurrentObservationStores()
    const listener = vi.fn()
    stores.sessions.subscribe(listener)
    const observation = sessionUsage('claude', 'session-1', 10)

    expect(stores.sessions.setUsage(observation)).toBe(true)
    expect(stores.sessions.setUsage(observation)).toBe(false)
    const read = stores.sessions.getUsage('claude', 'session-1')
    if (read?.availability.state === 'available') {
      const cumulative = read.availability.value.cumulativeTokens
      if (cumulative) cumulative.total = 999
    }

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'session-usage',
      providerId: 'claude',
      sessionId: 'session-1',
    }))
    expect(stores.sessions.getUsage('claude', 'session-1'))
      .toMatchObject({ availability: { value: { cumulativeTokens: { total: 10 } } } })
  })

  it('removes all observations for one session without touching another provider', () => {
    const stores = new ProviderCurrentObservationStores()
    const listener = vi.fn()
    stores.sessions.subscribe(listener)
    stores.sessions.setUsage(sessionUsage('claude', 'shared-session', 10))
    stores.sessions.setContext(sessionContext('claude', 'shared-session', 20))
    stores.sessions.setUsage(sessionUsage('codex', 'shared-session', 30))
    listener.mockClear()

    expect(stores.sessions.delete('claude', 'shared-session')).toBe(true)

    expect(stores.sessions.getUsage('claude', 'shared-session')).toBeUndefined()
    expect(stores.sessions.getContext('claude', 'shared-session')).toBeUndefined()
    expect(stores.sessions.getUsage('codex', 'shared-session')).toBeDefined()
    expect(listener).toHaveBeenCalledWith({
      kind: 'session-usage',
      providerId: 'claude',
      sessionId: 'shared-session',
      observation: undefined,
    })
    expect(listener).toHaveBeenCalledWith({
      kind: 'session-context',
      providerId: 'claude',
      sessionId: 'shared-session',
      observation: undefined,
    })
  })

  it('preserves opaque identity bytes instead of silently canonicalizing them', () => {
    const stores = new ProviderCurrentObservationStores()
    stores.quotas.set(quota('codex', 'work ', 25))

    expect(stores.quotas.get('codex', 'work ')).toBeDefined()
    expect(stores.quotas.get('codex', 'work')).toBeUndefined()
    expect(stores.toWire().providerQuota[0]?.scope.accountRef).toBe('work ')
  })

  it('does not collide distinct identity tuples containing NUL bytes', () => {
    const restored = ProviderCurrentObservationStores.fromWire({
      version: 1,
      sessionUsage: [],
      sessionContext: [],
      providerQuota: [
        quota('a\u0000b', 'c', 10),
        quota('a', 'b\u0000c', 20),
      ],
    })

    expect(restored.quotas.list()).toHaveLength(2)
  })
})

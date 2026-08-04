import { describe, expect, it } from 'vitest'
import { projectLegacySessionContextWindow } from '../legacy-observation-projections'

describe('legacy observation projections', () => {
  it('projects any provider current context without a Claude wire dependency', () => {
    expect(projectLegacySessionContextWindow({
      kind: 'session-context',
      providerId: 'forge',
      scope: { kind: 'session', sessionId: 'forge-session' },
      source: { id: 'forge-native', label: 'Forge native context' },
      freshness: {
        state: 'fresh',
        observedAt: '2026-08-01T12:00:00.000Z',
        checkedAt: '2026-08-01T12:00:01.000Z',
      },
      availability: {
        state: 'available',
        value: { usedPercent: 25, windowTokens: 100_000 },
      },
    })).toEqual({
      usedPercentage: 25,
      windowSize: 100_000,
      fetchedAt: '2026-08-01T12:00:00.000Z',
    })
  })

  it('does not turn unsupported or partial metrics into zeroes', () => {
    expect(projectLegacySessionContextWindow({
      kind: 'session-context',
      providerId: 'forge',
      scope: { kind: 'session', sessionId: 'forge-session' },
      source: null,
      freshness: {
        state: 'unknown',
        observedAt: null,
        checkedAt: '2026-08-01T12:00:01.000Z',
      },
      availability: { state: 'unsupported', reason: 'No context source' },
    })).toBeNull()
    expect(projectLegacySessionContextWindow({
      kind: 'session-context',
      providerId: 'forge',
      scope: { kind: 'session', sessionId: 'forge-session' },
      source: { id: 'partial', label: 'Partial context' },
      freshness: {
        state: 'fresh',
        observedAt: '2026-08-01T12:00:00.000Z',
        checkedAt: '2026-08-01T12:00:01.000Z',
      },
      availability: { state: 'available', value: { usedPercent: 25 } },
    })).toBeNull()
  })
})

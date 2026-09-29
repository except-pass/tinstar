import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseQuotaAxiReport, quotaLevel } from '../parse'

const recorded = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'recorded-quota-axi.json'), 'utf8'))

describe('parseQuotaAxiReport', () => {
  it('reads the recorded quota-axi document', () => {
    const report = parseQuotaAxiReport(recorded)
    expect(report.fetchedAt).toBe('2026-09-29T12:00:00.000Z')
    expect(report.providers.map(provider => provider.id)).toEqual(['claude', 'codex', 'grok', 'kimi'])

    const claude = report.providers[0]!
    expect(claude).toMatchObject({
      plan: 'pro',
      remainingPercent: 64,
      level: 'normal',
      limitingWindow: { id: 'seven_day', label: 'week', resetsAt: '2026-10-04T17:00:00.000Z' },
      projectedRunOutAt: '2026-10-02T03:00:00.000Z',
      runway: 'projected_exhaustion',
      error: null,
      refreshedAt: '2026-09-29T11:58:00.000Z',
      account: null,
    })

    expect(report.providers[1]).toMatchObject({
      id: 'codex',
      plan: 'plus',
      remainingPercent: 18,
      level: 'low',
      limitingWindow: { id: 'weekly', label: 'week', resetsAt: '2026-10-03T09:00:00.000Z' },
      projectedRunOutAt: null,
      runway: 'through_reset',
    })

    expect(report.providers[2]).toMatchObject({
      id: 'grok',
      plan: 'supergrok',
      remainingPercent: null,
      level: 'error',
      limitingWindow: null,
      error: 'usage endpoint rejected the session',
      refreshedAt: '2026-09-29T11:50:00.000Z',
    })

    expect(report.providers[3]).toMatchObject({
      id: 'kimi',
      remainingPercent: 3,
      level: 'critical',
      runway: 'exhausted_now',
      projectedRunOutAt: '2026-09-29T12:00:00.000Z',
    })
  })

  it('colours the rounded percent: 20 is normal, 5 is low', () => {
    expect(quotaLevel(20)).toBe('normal')
    expect(quotaLevel(19)).toBe('low')
    expect(quotaLevel(5)).toBe('low')
    expect(quotaLevel(4)).toBe('critical')
    expect(quotaLevel(null)).toBe('error')

    const report = parseQuotaAxiReport({
      generatedAt: '2026-09-29T12:00:00.000Z',
      providers: [
        provider('edge-normal', 19.6),
        provider('edge-low', 4.6),
        provider('edge-critical', 4.4),
      ],
    })
    expect(report.providers.map(item => [item.id, item.remainingPercent, item.level])).toEqual([
      ['edge-normal', 20, 'normal'],
      ['edge-low', 5, 'low'],
      ['edge-critical', 4, 'critical'],
    ])
  })

  it('keeps one icon per provider and uses the tightest account', () => {
    const report = parseQuotaAxiReport({
      generatedAt: '2026-09-29T12:00:00.000Z',
      providers: [
        { ...provider('codex', 40), accountKey: 'work', plan: 'plus' },
        {
          ...provider('codex', 12),
          accountKey: 'personal',
          plan: 'plus',
          state: { status: 'error', error: 'personal window lagged' },
        },
      ],
    })
    expect(report.providers).toHaveLength(1)
    expect(report.providers[0]).toMatchObject({
      id: 'codex',
      account: 'personal',
      remainingPercent: 12,
      level: 'low',
      error: 'personal window lagged',
    })
  })

  it('rejects a document that is not a provider report', () => {
    expect(() => parseQuotaAxiReport({ generatedAt: '2026-09-29T12:00:00.000Z' })).toThrow(/providers/)
    expect(() => parseQuotaAxiReport('nope')).toThrow(/providers/)
  })
})

function provider(id: string, remaining: number) {
  return {
    provider: id,
    plan: 'test',
    windows: [{ id: 'weekly', label: 'week', percentRemaining: remaining, resetsAt: '2026-10-01T00:00:00.000Z' }],
    state: { status: 'fresh', refreshedAt: '2026-09-29T11:00:00.000Z' },
    quotaSemantics: {
      effectiveAvailability: [{
        scope: 'all_models',
        status: 'known',
        effectivePercentRemaining: remaining,
        limitingWindowIds: ['weekly'],
        runway: { status: 'through_reset' },
      }],
    },
  }
}

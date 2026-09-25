import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, within } from '@testing-library/react'
import { apiFetch } from '../../../apiClient'
import { QuotaRail } from '..'
import {
  CODEX_QUOTA_UNSUPPORTED_REASON,
  GROK_QUOTA_UNSUPPORTED_REASON,
} from '../reasons'

vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn(),
}))

const NOW = Date.parse('2026-08-01T12:00:00.000Z')
const FETCHED = '2026-08-01T11:58:00.000Z'
const FIVE_HOUR_RESET = '2026-08-01T15:13:00.000Z'
const SEVEN_DAY_RESET = '2026-08-08T12:00:00.000Z'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function claudeBuckets(data: unknown, extra: Record<string, unknown> = {}) {
  return {
    fixture: true,
    fetchedAt: FETCHED,
    data,
    error: null,
    ...extra,
  }
}

function axiUnavailable() {
  return {
    ok: true,
    data: {
      schema: 'tinstar.v6.quota/1',
      fixture: false,
      codex: { state: 'unsupported', reason: CODEX_QUOTA_UNSUPPORTED_REASON },
      grok: { state: 'unsupported', reason: GROK_QUOTA_UNSUPPORTED_REASON },
      axi: { state: 'unavailable', reason: 'missing', fixture: false },
    },
  }
}

function axiReady(extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      schema: 'tinstar.v6.quota/1',
      fixture: true,
      codex: {
        state: 'unsupported',
        reason: CODEX_QUOTA_UNSUPPORTED_REASON,
        percent: 50,
      },
      grok: { state: 'unsupported', reason: GROK_QUOTA_UNSUPPORTED_REASON },
      axi: {
        state: 'available',
        schemaVersion: 6,
        fixture: true,
        generatedAt: '2026-08-01T11:59:00.000Z',
        accounts: [
          {
            provider: 'codex',
            accountKey: 'openai-codex',
            semantics: 'known',
            freshness: 'fresh',
            scopes: [
              {
                scope: 'all_models',
                status: 'known',
                percentRemaining: 40,
                unit: 'percent-remaining',
                runway: 'through_reset',
                resetsAt: '2026-08-07T19:12:00.000Z',
              },
              {
                scope: 'model:spark',
                status: 'known',
                percentRemaining: 12,
                unit: 'percent-remaining',
                runway: 'through_reset',
                resetsAt: null,
              },
            ],
          },
          {
            provider: 'codex',
            accountKey: 'openai-codex-work',
            semantics: 'known',
            freshness: 'fresh',
            scopes: [
              {
                scope: 'all_models',
                status: 'known',
                percentRemaining: 25,
                unit: 'percent-remaining',
                runway: 'exhausted_now',
                resetsAt: null,
              },
            ],
          },
        ],
      },
      ...extra,
    },
  }
}

function mockReads(cc: unknown, v6: unknown, ccStatus = 200) {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (path === '/api/cc-quota') return jsonResponse(cc, ccStatus)
    if (path === '/api/v6/quota') return jsonResponse(v6)
    return jsonResponse({ ok: false }, 404)
  })
}

function renderRail() {
  return render(<QuotaRail nowMs={NOW} pollMs={0} />)
}

describe('QuotaRail', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset()
  })

  it('shows Claude window percents with reset and freshness, and labels the fixture', async () => {
    mockReads(
      claudeBuckets({
        five_hour: { utilization: 33, resets_at: FIVE_HOUR_RESET },
        seven_day: { utilization: 10, resets_at: SEVEN_DAY_RESET },
      }),
      axiUnavailable(),
    )
    const view = renderRail()
    const claude = within(view.getByTestId('v6-quota-claude'))
    expect(await claude.findByText('67% left')).toBeTruthy()
    expect(claude.getByText('90% left')).toBeTruthy()
    expect(claude.getByText(/5h window · usage window · resets 3h 13m/)).toBeTruthy()
    expect(claude.getByText(/7d window · usage window · resets 7d 0h/)).toBeTruthy()
    expect(view.getByTestId('v6-quota-claude-freshness').textContent).toBe('updated 2m ago')
    expect(claude.getAllByRole('meter')).toHaveLength(2)
    expect(claude.getByTestId('v6-quota-fixture').textContent).toBe('fixture')
    expect(view.getByText('Provider windows. Not worker context.')).toBeTruthy()
    expect(apiFetch).toHaveBeenCalledWith('/api/cc-quota')
    expect(apiFetch).toHaveBeenCalledWith('/api/v6/quota')
  })

  it('renders a null snapshot as not configured and never as a meter', async () => {
    mockReads(claudeBuckets(null), axiUnavailable())
    const view = renderRail()
    const claude = within(view.getByTestId('v6-quota-claude'))
    expect(await claude.findByText('not configured')).toBeTruthy()
    expect(claude.queryByRole('meter')).toBeNull()
    expect(claude.queryByText(/0%/)).toBeNull()
    expect(claude.queryByText(/100%/)).toBeNull()
  })

  it('renders null buckets inside a snapshot as not configured, without a meter', async () => {
    mockReads(claudeBuckets({ five_hour: null, seven_day: null }), axiUnavailable())
    const view = renderRail()
    const fiveHour = within(await view.findByTestId('v6-quota-claude-5h'))
    expect(fiveHour.getByText('not configured')).toBeTruthy()
    expect(within(view.getByTestId('v6-quota-claude-7d')).getByText('not configured')).toBeTruthy()
    expect(view.getByTestId('v6-quota-claude').querySelector('[role="meter"]')).toBeNull()
  })

  it('renders a failed fetch as unavailable, with no zero bar and no full bar', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('offline'))
    const view = renderRail()
    const claude = within(view.getByTestId('v6-quota-claude'))
    expect(await claude.findByText('unavailable')).toBeTruthy()
    expect(view.getByTestId('v6-quota-rail').querySelector('[role="meter"]')).toBeNull()
    expect(view.queryByText(/0%/)).toBeNull()
    expect(view.queryByText(/100%/)).toBeNull()
    expect(view.queryByText(/unlimited/i)).toBeNull()
  })

  it('renders a non-OK Claude response as unavailable, with no meter', async () => {
    mockReads(claudeBuckets(null), axiUnavailable(), 503)
    const view = renderRail()
    const claude = within(view.getByTestId('v6-quota-claude'))
    expect(await claude.findByText('unavailable')).toBeTruthy()
    expect(claude.queryByRole('meter')).toBeNull()
  })

  it('keeps a measured empty or full window labeled as a usage-window percent', async () => {
    mockReads(
      claudeBuckets({
        five_hour: { utilization: 0, resets_at: FIVE_HOUR_RESET },
        seven_day: { utilization: 100, resets_at: SEVEN_DAY_RESET },
      }),
      axiUnavailable(),
    )
    const view = renderRail()
    const claude = within(view.getByTestId('v6-quota-claude'))
    expect(await claude.findByText('100% left')).toBeTruthy()
    expect(claude.getByText('0% left')).toBeTruthy()
    const meters = claude.getAllByRole('meter')
    expect(meters.map((meter) => meter.getAttribute('aria-valuenow'))).toEqual(['100', '0'])
    expect(claude.queryByText(/unlimited/i)).toBeNull()
    expect(claude.queryByText(/tokens/i)).toBeNull()
  })

  it('shows Codex and Grok as Unsupported with the adapter reasons and no percent', async () => {
    mockReads(claudeBuckets(null), axiReady())
    const view = renderRail()
    const codex = within(view.getByTestId('v6-quota-codex'))
    const grok = within(view.getByTestId('v6-quota-grok'))
    expect(codex.getByText('Unsupported')).toBeTruthy()
    expect(codex.getByText(CODEX_QUOTA_UNSUPPORTED_REASON)).toBeTruthy()
    expect(grok.getByText('Unsupported')).toBeTruthy()
    expect(grok.getByText(GROK_QUOTA_UNSUPPORTED_REASON)).toBeTruthy()
    expect(codex.queryByRole('meter')).toBeNull()
    expect(grok.queryByRole('meter')).toBeNull()
    expect(codex.queryByText(/50%/)).toBeNull()
    expect(codex.queryByText(/%/)).toBeNull()
    expect(grok.queryByText(/%/)).toBeNull()
  })

  it('shows each quota-axi account in percent remaining and does not sum them', async () => {
    mockReads(claudeBuckets(null), axiReady())
    const view = renderRail()
    expect(await view.findByText('40% remaining')).toBeTruthy()
    const axi = within(view.getByTestId('v6-quota-axi'))
    expect(axi.getByText('fixture')).toBeTruthy()
    expect(axi.getByText(/schema 6/)).toBeTruthy()
    expect(axi.getByText(/updated 1m ago/)).toBeTruthy()
    const home = within(view.getByTestId('v6-quota-axi-codex-openai-codex'))
    const work = within(view.getByTestId('v6-quota-axi-codex-openai-codex-work'))
    expect(home.getByText('40% remaining')).toBeTruthy()
    expect(home.getByText('12% remaining')).toBeTruthy()
    expect(home.getByText(/all_models · percent remaining · runway through_reset · resets 6d 7h/)).toBeTruthy()
    expect(home.getByText(/model:spark · percent remaining/)).toBeTruthy()
    expect(work.getByText('25% remaining')).toBeTruthy()
    expect(axi.queryByText('65% remaining')).toBeNull()
    expect(axi.queryByText(/total/i)).toBeNull()
    expect(axi.queryByText(/tokens/i)).toBeNull()
    expect(home.getAllByRole('meter')).toHaveLength(2)
    expect(work.getAllByRole('meter')).toHaveLength(1)
  })

  it('shows quota-axi unavailable without a meter when the route has no snapshot', async () => {
    mockReads(claudeBuckets({
      five_hour: { utilization: 33, resets_at: FIVE_HOUR_RESET },
      seven_day: { utilization: 10, resets_at: SEVEN_DAY_RESET },
    }), axiUnavailable())
    const view = renderRail()
    expect(await view.findByText('67% left')).toBeTruthy()
    const axi = within(view.getByTestId('v6-quota-axi'))
    expect(axi.getByText('unavailable')).toBeTruthy()
    expect(axi.queryByRole('meter')).toBeNull()
  })

  it('does not treat a context-window fraction as account quota', async () => {
    mockReads(
      claudeBuckets(null, { contextWindow: { usedPercentage: 91, windowSize: 200000 } }),
      axiUnavailable(),
    )
    const view = renderRail()
    expect(await within(view.getByTestId('v6-quota-claude')).findByText('not configured')).toBeTruthy()
    expect(view.queryByText(/91/)).toBeNull()
    expect(view.queryByText(/tokens/i)).toBeNull()
    expect(view.queryByText(/context window/i)).toBeNull()
  })

  it('keeps a real usage window when a context fraction is also present, and ignores a summed total', async () => {
    mockReads(
      claudeBuckets(
        {
          five_hour: { utilization: 33, resets_at: FIVE_HOUR_RESET },
          seven_day: null,
        },
        { contextWindow: { usedPercentage: 91 } },
      ),
      axiReady({ total: 65 }),
    )
    const view = renderRail()
    expect(await view.findByText('67% left')).toBeTruthy()
    expect(view.queryByText(/91/)).toBeNull()
    expect(view.queryByText(/65/)).toBeNull()
    expect(view.queryByText(/tokens/i)).toBeNull()
    expect(within(view.getByTestId('v6-quota-claude-5h')).getByRole('meter')).toBeTruthy()
    expect(within(view.getByTestId('v6-quota-claude-7d')).queryByRole('meter')).toBeNull()
    expect(within(view.getByTestId('v6-quota-claude-7d')).getByText('not configured')).toBeTruthy()
  })
})

// @vitest-environment jsdom
import { fireEvent, render, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAccountQuotaObservationWire } from '../../../domain/provider-observation-wire'
import type { HudSnapshot } from '../../../server/observability/types'
import { CanvasHud } from '../CanvasHud'

const testState = vi.hoisted(() => ({
  quotas: [] as ProviderAccountQuotaObservationWire[],
  error: null as string | null,
  telemetrySnapshot: null as HudSnapshot | null,
  legacyQuotaHook: vi.fn(() => ({ snapshot: { state: 'ready' } })),
}))

vi.mock('../../../hooks/useTelemetryHud', () => ({
  useTelemetryHud: () => ({ snapshot: testState.telemetrySnapshot }),
}))
vi.mock('../../../hooks/useFleetTelemetrySeries', () => ({
  useFleetTelemetrySeries: () => ({ tsSec: [], cost: [], tokens: [], cache: [], duty: [] }),
}))
vi.mock('../../../hooks/providerObservationsStore', () => ({
  useProviderObservations: () => ({
    observations: {
      version: 1,
      sessionUsage: [],
      sessionContext: [],
      providerQuota: testState.quotas,
    },
    managedSessions: [],
    error: testState.error,
    loaded: true,
  }),
  useProviderQuotaObservations: () => ({
    observations: testState.quotas,
    error: testState.error,
    loaded: true,
  }),
}))
vi.mock('../../../hooks/useCcQuota', () => ({
  useCcQuota: testState.legacyQuotaHook,
}))
vi.mock('../../../context/ConfigContext', () => ({ useConfig: () => null }))
vi.mock('../../../lib/uiPrefs', () => ({ getPref: () => true, setPref: () => undefined }))
vi.mock('../TurnLengthFleet', () => ({ TurnLengthFleet: () => null }))
vi.mock('../ProviderFleetObservations', () => ({ ProviderFleetObservations: () => null }))

describe('<CanvasHud> provider quota integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    testState.legacyQuotaHook.mockClear()
    testState.error = null
    testState.telemetrySnapshot = null
    testState.quotas = [
      availableQuota('claude', 'default', '5 hours', 33),
      availableQuota('codex', 'team-a', 'Primary window', 61),
    ]
  })

  it('renders provider quota as HUD data without legacy telemetry or Claude quota polling', () => {
    const view = render(<CanvasHud runMap={new Map()} embedded />)

    expect(view.getByTestId('canvas-hud')).toBeTruthy()
    const claude = within(view.getByTestId('provider-quota-card-claude-default'))
    const codex = within(view.getByTestId('provider-quota-card-codex-team-a'))
    expect(claude.getByText(/5 hours/)).toBeTruthy()
    expect(codex.getByText(/Primary window/)).toBeTruthy()
    expect(view.queryByTestId('cc-quota-card')).toBeNull()
    expect(testState.legacyQuotaHook).not.toHaveBeenCalled()
  })

  it('keeps degraded telemetry details and retry beside an unavailable quota placeholder', () => {
    const unavailable = availableQuota('claude', 'default', '5 hours', 33)
    unavailable.freshness = {
      state: 'unknown',
      observedAt: null,
      checkedAt: '2026-08-01T12:00:00.000Z',
    }
    unavailable.availability = {
      state: 'unavailable',
      reason: 'not-observed',
      message: 'Waiting for provider quota',
    }
    testState.quotas = [unavailable]
    testState.telemetrySnapshot = telemetrySnapshot({
      state: 'degraded',
      error: 'prometheus unavailable',
    })
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    const view = render(<CanvasHud runMap={new Map()} embedded />)

    expect(view.getByText('⚠ telemetry degraded')).toBeTruthy()
    expect(view.getByText('prometheus unavailable')).toBeTruthy()
    expect(view.getByText('Unavailable · Waiting for provider quota')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/telemetry/restart',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
  })

  it('keeps telemetry initialization visible when provider quota refresh fails', () => {
    testState.quotas = []
    testState.error = 'HTTP 503'
    testState.telemetrySnapshot = telemetrySnapshot({
      state: 'downloading',
      progress: [{
        component: 'prometheus',
        bytesReceived: 1_048_576,
        bytesTotal: 2_097_152,
      }],
    })

    const view = render(<CanvasHud runMap={new Map()} embedded />)

    expect(view.getByText('DOWNLOADING TELEMETRY')).toBeTruthy()
    expect(view.getByText('1.0 / 2.0 MB')).toBeTruthy()
    expect(view.getByRole('status').textContent).toContain('Quota refresh failed · HTTP 503')
  })
})

function telemetrySnapshot(overrides: Partial<HudSnapshot>): HudSnapshot {
  return {
    window: 'today',
    state: 'ready',
    cost: { total: null, byModel: {} },
    tokens: { total: null },
    rate: { perMin: null, perHour: null },
    cacheHitPct: null,
    dutyCycle: { value: null, windowMinutes: 5 },
    ...overrides,
  }
}

function availableQuota(
  providerId: string,
  accountRef: string,
  label: string,
  usedPercent: number,
): ProviderAccountQuotaObservationWire {
  return {
    kind: 'provider-quota',
    providerId,
    scope: { kind: 'provider', accountRef },
    source: { id: 'native', label: `${providerId} native quota` },
    freshness: {
      state: 'fresh',
      observedAt: '2026-08-01T12:00:00.000Z',
      checkedAt: '2026-08-01T12:00:00.000Z',
    },
    availability: {
      state: 'available',
      value: { windows: [{ id: label, label, windowMinutes: 300, usedPercent }] },
    },
  }
}

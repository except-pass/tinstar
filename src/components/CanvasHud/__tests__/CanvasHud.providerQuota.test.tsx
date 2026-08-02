// @vitest-environment jsdom
import { render, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAccountQuotaObservationWire } from '../../../domain/provider-observation-wire'
import { CanvasHud } from '../CanvasHud'

const testState = vi.hoisted(() => ({
  quotas: [] as ProviderAccountQuotaObservationWire[],
  error: null as string | null,
  legacyQuotaHook: vi.fn(() => ({ snapshot: { state: 'ready' } })),
}))

vi.mock('../../../hooks/useTelemetryHud', () => ({
  useTelemetryHud: () => ({ snapshot: null }),
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
vi.mock('../TelemetryBootstrap', () => ({ TelemetryBootstrap: () => null }))
vi.mock('../TurnLengthFleet', () => ({ TurnLengthFleet: () => null }))
vi.mock('../ProviderFleetObservations', () => ({ ProviderFleetObservations: () => null }))

describe('<CanvasHud> provider quota integration', () => {
  beforeEach(() => {
    testState.legacyQuotaHook.mockClear()
    testState.error = null
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
})

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

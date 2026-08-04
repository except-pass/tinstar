// @vitest-environment jsdom
import { fireEvent, render, waitFor } from '@testing-library/react'
import { Profiler } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TelemetryPanel } from '../TelemetryPanel'

const testState = vi.hoisted(() => ({
  providerSessions: [] as Record<string, unknown>[],
  legacySnapshot: null as Record<string, unknown> | null,
  tokensEnabled: true,
  providerError: null as string | null,
  providerHistoryRequests: [] as Array<[string | null, string | null]>,
  providerHistory: {
    tsSec: [1, 2],
    tokens: [1_000, 1_200] as Array<number | null>,
    source: 'Tinstar provider observation history',
    freshness: 'fresh',
    error: null as string | null,
  },
}))

vi.mock('../../../hooks/useTelemetrySession', async () => {
  const { useRef } = await import('react')
  return {
    useTelemetrySession: (sessionId: string) => {
      const mounted = useRef({ sessionId, snapshot: testState.legacySnapshot })
      if (mounted.current.sessionId === sessionId) {
        mounted.current.snapshot = testState.legacySnapshot
      }
      return mounted.current.snapshot
    },
  }
})
vi.mock('../../../hooks/useTelemetrySeries', () => ({
  useTelemetrySeries: () => null,
}))
vi.mock('../../../context/ConfigContext', () => ({
  useConfig: () => ({
    ui: {
      telemetryPanels: {
        cost: true,
        tokens: testState.tokensEnabled,
        cacheHit: false,
        duty: true,
        turnLength: false,
      },
    },
  }),
}))
vi.mock('../../../hooks/providerObservationsStore', () => ({
  useProviderSessionObservationState: () => ({
    observations: testState.providerSessions,
    error: testState.providerError,
    loaded: true,
  }),
}))

function codexProviderSession() {
  return {
    providerId: 'codex',
    usage: {
      kind: 'session-usage',
      providerId: 'codex',
      scope: { kind: 'session', sessionId: 'run-1' },
      source: { id: 'rollout', label: 'Codex rollout events' },
      freshness: {
        state: 'fresh',
        observedAt: '2026-08-01T12:00:00.000Z',
        checkedAt: '2026-08-01T12:00:00.000Z',
      },
      availability: {
        state: 'available',
        value: { model: 'gpt-5.4', cumulativeTokens: { total: 1_200 } },
      },
    },
    context: {
      kind: 'session-context',
      providerId: 'codex',
      scope: { kind: 'session', sessionId: 'run-1' },
      source: { id: 'rollout', label: 'Codex rollout events' },
      freshness: {
        state: 'fresh',
        observedAt: '2026-08-01T12:00:00.000Z',
        checkedAt: '2026-08-01T12:00:00.000Z',
      },
      availability: {
        state: 'available',
        value: { usedPercent: 37, windowTokens: 200_000 },
      },
    },
  }
}
vi.mock('../../../hooks/useProviderTelemetrySeries', () => ({
  useProviderTelemetrySeries: (providerId: string | null, sessionId: string | null) => {
    testState.providerHistoryRequests.push([providerId, sessionId])
    return testState.providerHistory
  },
}))
vi.mock('../TurnLengthPanel', () => ({ TurnLengthPanel: () => null }))

describe('<TelemetryPanel> provider observations', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    testState.providerSessions = [codexProviderSession()]
    testState.legacySnapshot = null
    testState.tokensEnabled = true
    testState.providerError = null
    testState.providerHistoryRequests = []
    testState.providerHistory = {
      tsSec: [1, 2],
      tokens: [1_000, 1_200],
      source: 'Tinstar provider observation history',
      freshness: 'fresh',
      error: null,
    }
  })

  it('renders one provider-neutral chart set alongside live context', () => {
    testState.legacySnapshot = legacySnapshot(1_200)
    const view = render(<TelemetryPanel sessionId="run-1" runAccent="#22d3ee" />)

    expect(view.getAllByText('COST')).toHaveLength(1)
    expect(view.getAllByText('TOKENS')).toHaveLength(1)
    expect(view.getAllByText('DUTY')).toHaveLength(1)
    expect(view.getByText('1.2k')).toBeTruthy()
    expect(view.getByTitle(/Context window: 37.0% of 200,000 tokens/)).toBeTruthy()
    expect(view.queryByText(/Codex TOKENS/i)).toBeNull()
    expect(view.queryByText(/PROMETHEUS/i)).toBeNull()
    expect(view.queryByText(/provider signals/i)).toBeNull()
  })

  it('does not render a detailed treemap when the provider reports it unsupported', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'CONFLICT', message: 'unsupported' },
    }), { status: 409 })))
    const view = render(<TelemetryPanel sessionId="run-1" runAccent="#22d3ee" />)

    fireEvent.click(view.getByRole('button', { name: /Context/ }))

    await waitFor(() => {
      expect(view.getByText('Detailed context breakdown unavailable for this provider')).toBeTruthy()
    })
    expect(view.queryByText('System prompt')).toBeNull()
  })

  it('removes a previously loaded treemap when a refresh reports the provider unsupported', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(contextResponse())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error: { code: 'CONFLICT', message: 'unsupported' },
      }), { status: 409 }))
    vi.stubGlobal('fetch', fetchMock)
    const view = render(<TelemetryPanel sessionId="run-1" runAccent="#22d3ee" />)

    fireEvent.click(view.getByRole('button', { name: /Context/ }))
    await waitFor(() => expect(view.getByText(/Sys prompt/)).toBeTruthy())

    fireEvent.click(view.getByRole('button', { name: /Context/ }))
    await waitFor(() => {
      expect(view.getByText('Detailed context breakdown unavailable for this provider')).toBeTruthy()
    })
    expect(view.queryByText(/Sys prompt/)).toBeNull()
  })

  it('never paints detailed context from the prior provider identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => contextResponse()))
    const frames: string[] = []
    let container: HTMLElement | null = null
    const captureFrame = () => {
      if (container) frames.push(container.textContent ?? '')
    }
    const view = render(
      <Profiler id="telemetry" onRender={captureFrame}>
        <TelemetryPanel sessionId="run-1" runAccent="#22d3ee" />
      </Profiler>,
    )
    container = view.container

    fireEvent.click(view.getByRole('button', { name: /Context/ }))
    await waitFor(() => expect(view.getByText(/Sys prompt/)).toBeTruthy())

    frames.length = 0
    testState.providerSessions = [withProviderIdentity(codexProviderSession(), 'forge')]
    view.rerender(
      <Profiler id="telemetry" onRender={captureFrame}>
        <TelemetryPanel sessionId="run-1" runAccent="#22d3ee" />
      </Profiler>,
    )

    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(frame => !frame.includes('Sys prompt'))).toBe(true)
    expect(view.queryByText(/Sys prompt/)).toBeNull()
  })

  it('never paints legacy telemetry from the previous session identity', () => {
    testState.providerSessions = []
    testState.legacySnapshot = legacySnapshot(4_200)
    const frames: string[] = []
    let container: HTMLElement | null = null
    const captureFrame = () => {
      if (container) frames.push(container.textContent ?? '')
    }
    const view = render(
      <Profiler id="telemetry" onRender={captureFrame}>
        <TelemetryPanel sessionId="run-1" runAccent="#22d3ee" />
      </Profiler>,
    )
    container = view.container
    expect(view.getByText('4.2k')).toBeTruthy()

    frames.length = 0
    testState.legacySnapshot = legacySnapshot(900)
    view.rerender(
      <Profiler id="telemetry" onRender={captureFrame}>
        <TelemetryPanel sessionId="run-2" runAccent="#22d3ee" />
      </Profiler>,
    )

    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every(frame => !frame.includes('4.2k'))).toBe(true)
    expect(view.queryByText('4.2k')).toBeNull()
    expect(view.getByText('900')).toBeTruthy()
  })

  it('respects the token panel preference while retaining the context meter', () => {
    testState.legacySnapshot = legacySnapshot(4_200)
    testState.tokensEnabled = false

    const view = render(<TelemetryPanel sessionId="run-1" runAccent="#22d3ee" />)

    expect(view.queryByText('TOKENS')).toBeNull()
    expect(view.getByTitle(/Context window: 37.0% of 200,000 tokens/)).toBeTruthy()
  })
})

function contextResponse(): Response {
  return new Response(JSON.stringify({
    ok: true,
    data: {
      categories: [
        { name: 'System prompt', tokens: 100_000 },
        { name: 'Free space', tokens: 100_000 },
      ],
      totalTokens: 100_000,
      maxTokens: 200_000,
      percentage: 50,
      model: 'test-model',
      isAutoCompactEnabled: false,
      autoCompactThreshold: null,
    },
  }), { status: 200 })
}

function legacySnapshot(total: number) {
  return {
    state: 'ready',
    cost: { total: null, byModel: {} },
    tokens: { total },
    rate: { perMin: 12, perHour: 720 },
    cacheHitPct: null,
    dutyCycle: { value: null, windowMinutes: 5 },
    burningRunIds: [],
    window: 'today',
  }
}

function withProviderIdentity(
  provider: ReturnType<typeof codexProviderSession>,
  providerId: string,
): ReturnType<typeof codexProviderSession> {
  return {
    ...provider,
    providerId,
    usage: { ...provider.usage, providerId },
    context: { ...provider.context, providerId },
  }
}

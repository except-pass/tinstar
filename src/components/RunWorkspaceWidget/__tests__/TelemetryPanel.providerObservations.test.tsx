// @vitest-environment jsdom
import { fireEvent, render, waitFor, within } from '@testing-library/react'
import { Profiler } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TelemetryPanel } from '../TelemetryPanel'

const testState = vi.hoisted(() => ({
  providerSessions: [] as Record<string, unknown>[],
  legacySnapshot: null as Record<string, unknown> | null,
  tokensEnabled: true,
  providerError: null as string | null,
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
  useProviderTelemetrySeries: () => testState.providerHistory,
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
    testState.providerHistory = {
      tsSec: [1, 2],
      tokens: [1_000, 1_200],
      source: 'Tinstar provider observation history',
      freshness: 'fresh',
      error: null,
    }
  })

  it('renders Codex native token history and live context without Claude telemetry', () => {
    const view = render(<TelemetryPanel sessionId="run-1" runAccent="#22d3ee" />)

    expect(view.getByTestId('provider-session-signal-codex')).toBeTruthy()
    expect(view.getByText(/Codex TOKENS/i)).toBeTruthy()
    expect(view.getByText('1.2k')).toBeTruthy()
    expect(view.getByText('37% context')).toBeTruthy()
    expect(view.getByTitle(/Context window: 37.0% of 200,000 tokens/)).toBeTruthy()
    expect(view.queryByText(/COST · PROMETHEUS/)).toBeNull()
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

  it('retains legacy tokens when provider usage is unavailable instead of replacing it with zero-like data', () => {
    testState.providerSessions = [{
      ...codexProviderSession(),
      usage: {
        ...codexProviderSession().usage,
        availability: { state: 'unavailable', reason: 'not-observed' },
      },
    }]
    testState.legacySnapshot = {
      state: 'ready',
      cost: { total: null, byModel: {} },
      tokens: { total: 4_200 },
      rate: { perMin: 12, perHour: 720 },
      cacheHitPct: null,
      dutyCycle: { value: null, windowMinutes: 5 },
      burningRunIds: [],
      window: 'today',
    }

    const view = render(<TelemetryPanel sessionId="run-1" runAccent="#22d3ee" />)

    expect(view.getByText('TOKENS · PROMETHEUS')).toBeTruthy()
    expect(view.getByText('4.2k')).toBeTruthy()
    expect(view.getByText('37% context')).toBeTruthy()
  })

  it('retains legacy cumulative history for latest-turn-only provider usage', () => {
    const provider = codexProviderSession()
    testState.providerSessions = [{
      ...provider,
      usage: {
        ...provider.usage,
        availability: {
          state: 'available',
          value: { model: 'gpt-5.4', latestTurnTokens: { input: 7, output: 3 } },
        },
      },
    }]
    testState.providerHistory = {
      tsSec: [],
      tokens: [],
      source: 'Tinstar provider observation history',
      freshness: 'unknown',
      error: 'not observed',
    }
    testState.legacySnapshot = {
      state: 'ready',
      cost: { total: null, byModel: {} },
      tokens: { total: 4_200 },
      rate: { perMin: 12, perHour: 720 },
      cacheHitPct: null,
      dutyCycle: { value: null, windowMinutes: 5 },
      burningRunIds: [],
      window: 'today',
    }

    const view = render(<TelemetryPanel sessionId="run-1" runAccent="#22d3ee" />)

    expect(view.getByText('TOKENS · PROMETHEUS')).toBeTruthy()
    expect(view.getByText('4.2k')).toBeTruthy()
    expect(view.getByText(/Codex TOKENS/i)).toBeTruthy()
    expect(view.getByText('10')).toBeTruthy()
  })

  it('respects the token panel preference while retaining provider context', () => {
    testState.tokensEnabled = false

    const view = render(<TelemetryPanel sessionId="run-1" runAccent="#22d3ee" />)

    expect(view.queryByText(/Codex TOKENS/i)).toBeNull()
    expect(view.getByText('37% context')).toBeTruthy()
  })

  it('labels usage and context provenance independently and exposes refresh failure', () => {
    const provider = codexProviderSession()
    testState.providerSessions = [{
      ...provider,
      context: {
        ...provider.context,
        source: { id: 'context', label: 'Context source' },
        freshness: {
          state: 'stale',
          observedAt: '2026-08-01T11:59:00.000Z',
          checkedAt: '2026-08-01T12:00:00.000Z',
        },
      },
    }]
    const view = render(<TelemetryPanel sessionId="run-1" runAccent="#22d3ee" />)

    const usage = within(view.getByTestId('provider-usage-provenance'))
    const context = within(view.getByTestId('provider-context-provenance'))
    expect(usage.getByText('fresh')).toBeTruthy()
    expect(usage.getByText(/Codex rollout events/)).toBeTruthy()
    expect(context.getByText('stale')).toBeTruthy()
    expect(context.getByText(/Context source/)).toBeTruthy()

    testState.providerError = 'HTTP 503'
    view.rerender(<TelemetryPanel sessionId="run-1" runAccent="#22d3ee" />)

    expect(within(view.getByTestId('provider-usage-provenance')).getByText('refresh failed')).toBeTruthy()
    expect(within(view.getByTestId('provider-context-provenance')).getByText('refresh failed')).toBeTruthy()
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

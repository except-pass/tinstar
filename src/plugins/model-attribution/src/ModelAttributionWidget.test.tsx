// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { makeModelAttributionWidget } from './ModelAttributionWidget'

/** Minimal Response stub for api.http.fetch. */
function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response
}

const STATE_FIXTURE = {
  sessions: [
    { name: 'marshal', model: 'claude-opus-4-8' },
    { name: 'scout', model: 'claude-sonnet-4-5' },
    { name: 'fresh-hand', model: null },
  ],
}

const QUOTA_FIXTURE = {
  fetchedAt: '2026-06-19T00:00:00Z',
  data: {
    five_hour: { utilization: 42, resets_at: '2026-06-19T05:00:00Z' },
    seven_day: { utilization: 7, resets_at: '2026-06-26T00:00:00Z' },
  },
  error: null,
}

function makeMockApi(): { api: TinstarPluginAPI; dispose: () => void } {
  const dispose = vi.fn()
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/api/state') return jsonResponse(STATE_FIXTURE)
    if (path === '/api/cc-quota') return jsonResponse(QUOTA_FIXTURE)
    throw new Error(`unexpected fetch path: ${path}`)
  })
  const api = {
    pluginId: 'model-attribution',
    version: '1.0.0',
    http: { fetch: fetchMock },
    events: { subscribe: vi.fn(() => ({ dispose })) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as TinstarPluginAPI
  return { api, dispose }
}

const widgetProps: WidgetProps = {
  data: null,
  zoom: 1,
  isSelected: false,
  isDragging: false,
  isHovered: false,
  isDropTarget: false,
}

describe('ModelAttributionWidget', () => {
  it('renders each session with its model, "—" for a null-model session, the cc-quota headroom, and the GPU-degraded placeholder', async () => {
    const { api } = makeMockApi()
    const Widget = makeModelAttributionWidget(api)
    render(<Widget {...widgetProps} />)

    // Session names render.
    await waitFor(() => {
      expect(screen.getByText('marshal')).toBeInTheDocument()
    })
    expect(screen.getByText('scout')).toBeInTheDocument()
    expect(screen.getByText('fresh-hand')).toBeInTheDocument()

    // Their models render (prefix-stripped for readability).
    expect(screen.getByText('opus-4-8')).toBeInTheDocument()
    expect(screen.getByText('sonnet-4-5')).toBeInTheDocument()

    // The null-model session degrades to an em dash.
    expect(screen.getByText('—')).toBeInTheDocument()

    // cc-quota headroom (5h / 7d utilization).
    expect(screen.getByText('42%')).toBeInTheDocument()
    expect(screen.getByText('7%')).toBeInTheDocument()

    // GPU panel degrades cleanly (no nvidia-smi source yet).
    expect(screen.getByTestId('gpu-degraded')).toHaveTextContent('GPU telemetry unavailable')
  })

  it('subscribes to telemetry:hud and disposes the subscription on unmount', () => {
    const { api, dispose } = makeMockApi()
    const Widget = makeModelAttributionWidget(api)
    const { unmount } = render(<Widget {...widgetProps} />)

    expect(api.events.subscribe).toHaveBeenCalledWith('telemetry:hud', expect.any(Function))
    unmount()
    expect(dispose).toHaveBeenCalled()
  })
})

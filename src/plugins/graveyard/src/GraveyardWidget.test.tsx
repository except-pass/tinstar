// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import { makeGraveyardWidget } from './GraveyardWidget'
import type { Tombstone } from './types'

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as unknown as Response
}

const GRAVES: Tombstone[] = [
  { convId: 'c1', sessionName: 'askviktor', coversSummary: 'Explored influx backfill strategy', task: 'Telemetry', retiredAt: '2026-06-30T09:00:00Z', snapshotted: true },
  { convId: 'c2', sessionName: 'graveyard-hand', coversSummary: 'Designed the necro flow', task: 'Graveyard', retiredAt: '2026-07-01T12:00:00Z', snapshotted: false },
]

function makeMockApi(reviveBody: unknown) {
  const dispose = vi.fn()
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/api/graveyard') return jsonResponse({ ok: true, data: GRAVES })
    if (path.endsWith('/revive')) return jsonResponse(reviveBody)
    if (path.endsWith('/purge')) return jsonResponse({ ok: true, data: null })
    throw new Error(`unexpected path ${path}`)
  })
  const api = {
    pluginId: 'graveyard', version: '1.0.0',
    http: { fetch: fetchMock },
    events: { subscribe: vi.fn(() => ({ dispose })) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as TinstarPluginAPI
  return { api, dispose, fetchMock }
}

const props: WidgetProps = { data: null, zoom: 1, isSelected: false, isDragging: false, isHovered: false, isDropTarget: false }

describe('GraveyardWidget', () => {
  it('lists retired sessions and filters by query', async () => {
    const { api } = makeMockApi({ ok: true, data: { revivable: true, sessionName: 'x' } })
    const Widget = makeGraveyardWidget(api)
    render(<Widget {...props} />)

    await waitFor(() => expect(screen.getByText(/Here lies askviktor/)).toBeInTheDocument())
    expect(screen.getByText(/Here lies graveyard-hand/)).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText(/Search the dearly departed/i), { target: { value: 'necro' } })
    await waitFor(() => expect(screen.queryByText(/Here lies askviktor/)).not.toBeInTheDocument())
    expect(screen.getByText(/Here lies graveyard-hand/)).toBeInTheDocument()
  })

  it('shows the summary-only notice when revive reports not-revivable (AE2)', async () => {
    const { api } = makeMockApi({ ok: true, data: { revivable: false, reason: 'transcript-unavailable' } })
    const Widget = makeGraveyardWidget(api)
    render(<Widget {...props} />)

    await waitFor(() => expect(screen.getByText(/Here lies askviktor/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/Here lies askviktor/))
    fireEvent.click(screen.getByRole('button', { name: /raise/i }))

    await waitFor(() => expect(screen.getByText(/summary\)? remains|only its epitaph/i)).toBeInTheDocument())
  })

  it('marks durable (snapshotted) graves distinctly from best-effort ones', async () => {
    const { api } = makeMockApi({ ok: true, data: { revivable: true } })
    const Widget = makeGraveyardWidget(api)
    render(<Widget {...props} />)

    await waitFor(() => expect(screen.getByText(/Here lies askviktor/)).toBeInTheDocument())
    // c1 is snapshotted → durable "Embalmed" affordance in the detail pane.
    fireEvent.click(screen.getByText(/Here lies askviktor/))
    expect(screen.getByText(/Embalmed/i)).toBeInTheDocument()
    // c2 is not snapshotted → best-effort note.
    fireEvent.click(screen.getByText(/Here lies graveyard-hand/))
    expect(screen.getByText(/Best-effort/i)).toBeInTheDocument()
  })

  it('shows a distinct error (not the empty state) when the load fails', async () => {
    const dispose = vi.fn()
    const api = {
      pluginId: 'graveyard', version: '1.0.0',
      http: { fetch: vi.fn(async () => { throw new Error('backend down') }) },
      events: { subscribe: vi.fn(() => ({ dispose })) },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as TinstarPluginAPI
    const Widget = makeGraveyardWidget(api)
    render(<Widget {...props} />)

    await waitFor(() => expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument())
    expect(screen.queryByText(/No retired sessions yet/i)).not.toBeInTheDocument()
  })

  it('keeps stale rows (no error li) when a refresh fails after a successful load', async () => {
    const dispose = vi.fn()
    let deltaHandler: ((m: { eventType?: string }) => void) | null = null
    let call = 0
    const api = {
      pluginId: 'graveyard', version: '1.0.0',
      http: { fetch: vi.fn(async () => {
        call += 1
        if (call === 1) return jsonResponse({ ok: true, data: GRAVES })
        throw new Error('refresh failed')
      }) },
      events: { subscribe: vi.fn((_ch: string, h: (m: { eventType?: string }) => void) => { deltaHandler = h; return { dispose } }) },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as TinstarPluginAPI
    const Widget = makeGraveyardWidget(api)
    render(<Widget {...props} />)

    await waitFor(() => expect(screen.getByText(/Here lies askviktor/)).toBeInTheDocument())
    // A tombstone.updated delta triggers a refresh that now fails.
    deltaHandler!({ eventType: 'tombstone.updated' })
    await waitFor(() => expect(screen.getByText(/couldn.t reach the graveyard/i)).toBeInTheDocument())
    // Stale rows persist; the prominent error li + retry button do not appear.
    expect(screen.getByText(/Here lies askviktor/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
  })

  it('subscribes to the delta channel and disposes on unmount', () => {
    const { api, dispose } = makeMockApi({ ok: true, data: { revivable: true } })
    const Widget = makeGraveyardWidget(api)
    const { unmount } = render(<Widget {...props} />)
    expect(api.events.subscribe).toHaveBeenCalledWith('delta', expect.any(Function))
    unmount()
    expect(dispose).toHaveBeenCalled()
  })
})

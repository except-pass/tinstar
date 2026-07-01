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
  { convId: 'c1', sessionName: 'askviktor', coversSummary: 'Explored influx backfill strategy', task: 'Telemetry', retiredAt: '2026-06-30T09:00:00Z' },
  { convId: 'c2', sessionName: 'graveyard-hand', coversSummary: 'Designed the necro flow', task: 'Graveyard', retiredAt: '2026-07-01T12:00:00Z' },
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

    await waitFor(() => expect(screen.getByText('askviktor')).toBeInTheDocument())
    expect(screen.getByText('graveyard-hand')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText(/Search what past sessions/i), { target: { value: 'necro' } })
    await waitFor(() => expect(screen.queryByText('askviktor')).not.toBeInTheDocument())
    expect(screen.getByText('graveyard-hand')).toBeInTheDocument()
  })

  it('shows the summary-only notice when revive reports not-revivable (AE2)', async () => {
    const { api } = makeMockApi({ ok: true, data: { revivable: false, reason: 'transcript-unavailable' } })
    const Widget = makeGraveyardWidget(api)
    render(<Widget {...props} />)

    await waitFor(() => expect(screen.getByText('askviktor')).toBeInTheDocument())
    fireEvent.click(screen.getByText('askviktor'))
    fireEvent.click(screen.getByRole('button', { name: /necro/i }))

    await waitFor(() => expect(screen.getByText(/summary-only/i)).toBeInTheDocument())
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

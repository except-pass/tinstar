// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, waitFor } from '@testing-library/react'
import { SaloonRefreshButton } from '../SaloonRefreshButton'

describe('<SaloonRefreshButton>', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders a refresh button with idle tooltip when healthy', () => {
    const { getByTestId } = render(
      <SaloonRefreshButton sessionName="alpha" natsControlOrphanedAt={null} />,
    )
    const btn = getByTestId('saloon-refresh-btn')
    expect(btn.getAttribute('title')).toBe('Reconnect Saloon observer')
    expect(btn.hasAttribute('disabled')).toBe(false)
  })

  it('renders with orphan tooltip when natsControlOrphanedAt is set', () => {
    const { getByTestId } = render(
      <SaloonRefreshButton sessionName="alpha" natsControlOrphanedAt="2026-05-12T00:00:00Z" />,
    )
    expect(getByTestId('saloon-refresh-btn').getAttribute('title'))
      .toBe('Reconnect Saloon — session is orphaned')
  })

  it('POSTs to /api/nats-traffic/bounce on click', async () => {
    const { getByTestId } = render(
      <SaloonRefreshButton sessionName="alpha" natsControlOrphanedAt={null} />,
    )
    fireEvent.click(getByTestId('saloon-refresh-btn'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/nats-traffic/bounce')
    expect(init?.method).toBe('POST')
  })

  it('disables the button while a request is in flight', async () => {
    let resolve!: (r: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>(r => { resolve = r }))
    const { getByTestId } = render(
      <SaloonRefreshButton sessionName="alpha" natsControlOrphanedAt={null} />,
    )
    const btn = getByTestId('saloon-refresh-btn') as HTMLButtonElement
    fireEvent.click(btn)
    await waitFor(() => expect(btn.disabled).toBe(true))
    resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    await waitFor(() => expect(btn.disabled).toBe(false))
  })

  it('permanently disables on 503 BRIDGE_UNAVAILABLE', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ ok: false, error: { code: 'BRIDGE_UNAVAILABLE', message: 'NATS bridge is disabled in tinstar config' } }),
      { status: 503 },
    ))
    const { getByTestId } = render(
      <SaloonRefreshButton sessionName="alpha" natsControlOrphanedAt={null} />,
    )
    const btn = getByTestId('saloon-refresh-btn') as HTMLButtonElement
    fireEvent.click(btn)
    await waitFor(() => expect(btn.disabled).toBe(true))
    expect(btn.getAttribute('title')).toBe('NATS bridge is disabled in tinstar config')
    // Stays disabled after the request resolves
    fireEvent.click(btn)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('shows error tooltip and re-enables on 500 BOUNCE_FAILED', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({ ok: false, error: { code: 'BOUNCE_FAILED', message: 'connect refused' } }),
      { status: 500 },
    ))
    const { getByTestId } = render(
      <SaloonRefreshButton sessionName="alpha" natsControlOrphanedAt={null} />,
    )
    const btn = getByTestId('saloon-refresh-btn') as HTMLButtonElement
    fireEvent.click(btn)
    await waitFor(() => expect(btn.getAttribute('title')).toContain('connect refused'))
    expect(btn.disabled).toBe(false)
  })
})

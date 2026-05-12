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

  it('does NOT show popover after successful bounce when not orphaned', async () => {
    const { queryByTestId, getByTestId } = render(
      <SaloonRefreshButton sessionName="alpha" natsControlOrphanedAt={null} />,
    )
    fireEvent.click(getByTestId('saloon-refresh-btn'))
    await waitFor(() => expect(fetchMock).toHaveBeenCalled())
    expect(queryByTestId('saloon-orphan-popover')).toBeNull()
  })

  it('shows popover after successful bounce when orphaned', async () => {
    const { getByTestId } = render(
      <SaloonRefreshButton sessionName="alpha" natsControlOrphanedAt="2026-05-12T00:00:00Z" />,
    )
    fireEvent.click(getByTestId('saloon-refresh-btn'))
    await waitFor(() => expect(getByTestId('saloon-orphan-popover')).toBeTruthy())
  })

  it('Cancel dismisses the popover without further fetches', async () => {
    const { getByTestId, queryByTestId } = render(
      <SaloonRefreshButton sessionName="alpha" natsControlOrphanedAt="2026-05-12T00:00:00Z" />,
    )
    fireEvent.click(getByTestId('saloon-refresh-btn'))
    await waitFor(() => expect(getByTestId('saloon-orphan-popover')).toBeTruthy())
    const callsBefore = fetchMock.mock.calls.length
    fireEvent.click(getByTestId('saloon-orphan-cancel'))
    await waitFor(() => expect(queryByTestId('saloon-orphan-popover')).toBeNull())
    expect(fetchMock.mock.calls.length).toBe(callsBefore)
  })

  it('Restart calls /stop then /start in order', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    const { getByTestId } = render(
      <SaloonRefreshButton sessionName="alpha" natsControlOrphanedAt="2026-05-12T00:00:00Z" />,
    )
    fireEvent.click(getByTestId('saloon-refresh-btn'))
    await waitFor(() => expect(getByTestId('saloon-orphan-popover')).toBeTruthy())
    fireEvent.click(getByTestId('saloon-orphan-restart'))
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3))
    const urls = fetchMock.mock.calls.map(c => c[0])
    const stopIdx = urls.indexOf('/api/sessions/alpha/stop')
    const startIdx = urls.indexOf('/api/sessions/alpha/start')
    expect(stopIdx).toBeGreaterThan(-1)
    expect(startIdx).toBeGreaterThan(stopIdx)
  })

  it('shows error inline if /stop fails; popover stays open', async () => {
    // First call: bounce success. Second call (/stop): failure.
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: false, error: { code: 'STOP_FAILED', message: 'no such tmux session' } }),
        { status: 500 },
      ))
    const { getByTestId } = render(
      <SaloonRefreshButton sessionName="alpha" natsControlOrphanedAt="2026-05-12T00:00:00Z" />,
    )
    fireEvent.click(getByTestId('saloon-refresh-btn'))
    await waitFor(() => expect(getByTestId('saloon-orphan-popover')).toBeTruthy())
    fireEvent.click(getByTestId('saloon-orphan-restart'))
    await waitFor(() => expect(getByTestId('saloon-orphan-error').textContent).toMatch(/no such tmux session/))
    // Popover still mounted
    expect(getByTestId('saloon-orphan-popover')).toBeTruthy()
  })
})

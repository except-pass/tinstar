import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkerDescriptor } from '../../contract/descriptor'
import { hashPaletteColor } from '../identity'
import { V6Shell } from '../V6Shell'

const alpha: WorkerDescriptor = {
  source: 'fm-fleet-snapshot',
  fixture: true,
  id: 'alpha',
  spawnGen: '1',
  project: 'tinstar',
  worktree: { path: '/tmp/alpha', present: true },
  backend: 'tmux',
  endpoint: { target: 'sess:alpha', exists: true, agentAlive: 'alive', status: 'alive' },
  crewState: 'working',
  observedAt: '2026-09-24T04:00:00Z',
}

const beta: WorkerDescriptor = {
  ...alpha,
  id: 'beta',
  crewState: 'parked',
  endpoint: { ...alpha.endpoint, target: 'sess:beta' },
}

function workersResponse(rows: WorkerDescriptor[], identities: Record<string, { color: string }> = {}) {
  return new Response(JSON.stringify({
    ok: true,
    data: { configured: true, workers: rows, identities, diagnostics: [] },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

describe('V6Shell', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cycles with ctrl+brackets, keeps the draft, ignores the wheel, and jumps to the board', async () => {
    let rows = [beta, alpha]
    const fetches: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      fetches.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('/api/v6/workers')) return workersResponse(rows, { alpha: { color: '#123456' } })
      if (url.includes('/api/v6/identity')) return new Response(JSON.stringify({ ok: true, data: { color: '#00f0ff' } }), { status: 200 })
      if (url.includes('/api/v6/intents') && init?.method === 'POST') {
        return new Response(JSON.stringify({
          ok: true,
          data: { disposition: 'queued', detail: 'queued', applied: false, requestId: 'req-1' },
        }), { status: 200 })
      }
      if (url.includes('/api/v6/intents/')) {
        return new Response(JSON.stringify({ ok: true, data: { reply: null, applied: false } }), { status: 200 })
      }
      return new Response('no', { status: 404 })
    }))

    render(<V6Shell pollMs={60_000} />)
    expect(await screen.findByTestId('worker-alpha')).toHaveAttribute('data-color', '#123456')
    expect(screen.getAllByTestId('fixture-label').length).toBeGreaterThan(0)
    expect(screen.getByTestId('crew-alpha')).toHaveTextContent('working')
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'alpha')
    expect(hashPaletteColor('alpha')).not.toBe('#123456')

    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'keep me' } })
    fireEvent.keyDown(window, { code: 'BracketRight', ctrlKey: true })
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')
    expect(screen.getByLabelText('Message')).toHaveValue('')
    fireEvent.wheel(screen.getByTestId('v6-shell'), { deltaY: 120 })
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')
    fireEvent.keyDown(window, { code: 'BracketLeft', ctrlKey: true })
    expect(screen.getByLabelText('Message')).toHaveValue('keep me')

    const alphaFrame = document.createElement('iframe')
    alphaFrame.dataset.testid = 'terminal-alpha'
    fireEvent.click(screen.getByTestId('worker-next'))
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')

    fireEvent.click(screen.getByTestId('board'))
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-view', 'portfolio')
    expect(screen.getByText('No epics yet.')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('back'))
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-view', 'worker')
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')

    rows = [alpha, beta]
    await waitFor(() => {
      expect(fetches.filter(line => line.startsWith('GET') && line.includes('/api/v6/workers')).length).toBeGreaterThan(0)
    })
    expect(screen.getByTestId('v6-shell')).toHaveAttribute('data-worker', 'beta')
    expect(screen.queryByText(/autonomous supervision/i)).toBeNull()
    expect(alphaFrame).toBeTruthy()
  })

  it('shows queued, not applied, then the receipt reply on the same worker', async () => {
    let reply: { body: string; appliedOutcome: string | null } | null = null
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v6/workers')) return workersResponse([alpha])
      if (url.includes('/api/v6/identity')) {
        return new Response(JSON.stringify({ ok: true, data: { color: hashPaletteColor('alpha') } }), { status: 200 })
      }
      if (url.includes('/api/v6/intents') && init?.method === 'POST') {
        const sent = JSON.parse(String(init.body)) as { kind: string; anchor: { ids: string[] } }
        expect(sent.kind).toBe('thread.message')
        expect(sent.anchor.ids).toEqual(['alpha'])
        return new Response(JSON.stringify({
          ok: true,
          data: { disposition: 'queued', detail: 'queued', applied: false },
        }), { status: 200 })
      }
      if (url.includes('/api/v6/intents/')) {
        return new Response(JSON.stringify({ ok: true, data: { reply, applied: reply?.appliedOutcome === 'applied' } }), { status: 200 })
      }
      return new Response('no', { status: 404 })
    }))

    render(<V6Shell pollMs={50} />)
    await screen.findByLabelText('Message')
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello worker' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Queued')).toBeInTheDocument()
    expect(screen.getByText('Not applied')).toBeInTheDocument()

    reply = { body: 'captain says hi', appliedOutcome: null }
    expect(await screen.findByTestId('intent-reply')).toHaveTextContent('captain says hi')
    expect(screen.getByText('Not applied')).toBeInTheDocument()
  })

  it('does not call a saved-unannounced note applied', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v6/workers')) return workersResponse([alpha])
      if (url.includes('/api/v6/identity')) return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
      if (init?.method === 'POST' && url.includes('/api/v6/intents')) {
        return new Response(JSON.stringify({
          ok: true,
          data: { disposition: 'saved-unannounced', detail: 'saved, not announced', applied: false },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, data: { reply: null } }), { status: 200 })
    }))
    render(<V6Shell pollMs={60_000} />)
    await screen.findByLabelText('Message')
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hello' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByText('Saved, not announced')).toBeInTheDocument()
    expect(screen.getByText('Not applied')).toBeInTheDocument()
    expect(screen.queryByText(/^Applied$/)).toBeNull()
  })
})

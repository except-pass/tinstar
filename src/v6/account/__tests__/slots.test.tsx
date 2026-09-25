import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyPortfolio } from '../../portfolio/model'
import { V6Shell } from '../../shell/V6Shell'
import * as slots from '../../shell/slots'
import { ActivePortfolio } from '../ActivePortfolio'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('shell slots', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('wires every landed module surface', () => {
    expect(slots.NeedsYouRail).toEqual(expect.any(Function))
    expect(slots.PortfolioBoard).toEqual(expect.any(Function))
    expect(slots.WorkerObjective).toEqual(expect.any(Function))
    expect(slots.QuotaRail).toEqual(expect.any(Function))
    expect(slots.ContextThread).toEqual(expect.any(Function))
  })

  it('shows the empty line until the active board loads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      data: { board: { ...emptyPortfolio(), fixture: true }, archivedEpicIds: ['epic-old'] },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    render(<ActivePortfolio />)
    expect(screen.getByText('No epics yet.')).toBeInTheDocument()
    expect(await screen.findByTestId('portfolio-board')).toBeInTheDocument()
    expect(screen.getByTestId('account-archived')).toHaveTextContent('History is kept')
    expect(screen.queryByText('No epics yet.')).toBeNull()
  })

  it('keeps the objective and thread empty until something is selected', () => {
    render(<slots.WorkerObjective />)
    expect(screen.getByText('No worker selected')).toBeInTheDocument()
    render(<slots.ContextThread />)
    expect(screen.getByText('Point at an epic, a plan, or a task to talk about it with First Mate.')).toBeInTheDocument()
  })

  it('passes an epic anchor into the thread slot', () => {
    render(
      <slots.ShellSelection value={{ workerId: null, view: { kind: 'epic', id: 'epic-9' } }}>
        <slots.ContextThread />
      </slots.ShellSelection>,
    )
    expect(screen.getByText('epic · epic-9')).toBeInTheDocument()
  })

  it('gives the selected worker to the objective and the thread', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo) => {
      const url = String(input)
      if (url.includes('/api/v6/workers')) {
        return jsonResponse({
          ok: true,
          data: {
            configured: true,
            workers: [{
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
            }],
            identities: {},
            diagnostics: [],
          },
        })
      }
      if (url.includes('/api/v6/identity')) return jsonResponse({ ok: true, data: {} })
      if (url.includes('/api/v6/objectives/')) return jsonResponse({ ok: false, error: { message: 'none' } })
      if (url.includes('/api/v6/threads')) return jsonResponse({ ok: true, data: { thread: null } })
      return new Response('no', { status: 404 })
    }))

    render(<V6Shell pollMs={60_000} />)
    expect(await screen.findByTestId('objective-worker')).toHaveTextContent('Worker alpha')
    expect(screen.getByText('worker · alpha')).toBeInTheDocument()
    expect(screen.queryByText('No worker selected')).toBeNull()
  })
})

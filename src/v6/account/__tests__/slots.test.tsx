import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyPortfolio } from '../../portfolio/model'
import * as slots from '../../shell/slots'
import { ActivePortfolio } from '../ActivePortfolio'

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
})

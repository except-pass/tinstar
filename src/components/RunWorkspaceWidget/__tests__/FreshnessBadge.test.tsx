// @vitest-environment jsdom
//
// What a human can tell APART on the Slate (plan U6, R18). The point of the badge
// is not that it exists but that the five phases and the orthogonal overdue flag
// are visibly different from each other and from the resting state.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { SurfaceFreshness } from '../../../types'
import { FreshnessBadge, freshnessTitle } from '../FreshnessBadge'

afterEach(cleanup)

function freshness(over: Partial<SurfaceFreshness> = {}): SurfaceFreshness {
  return { phase: 'current', overdue: false, ...over }
}

describe('FreshnessBadge', () => {
  it('renders NOTHING for a verified surface — the resting state is silence', () => {
    render(<FreshnessBadge freshness={freshness()} />)
    expect(screen.queryByTestId('freshness-badge')).toBeNull()
  })

  it('renders nothing at all when the surface has no canonical record behind it', () => {
    render(<FreshnessBadge />)
    expect(screen.queryByTestId('freshness-badge')).toBeNull()
  })

  it.each([
    ['possibly-stale', 'stale'],
    ['queued', 'queued'],
    ['refreshing', 'refreshing'],
    ['failed', 'failed'],
  ] as const)('labels %s distinctly', (phase, label) => {
    render(<FreshnessBadge freshness={freshness({ phase })} />)
    const badge = screen.getByTestId('freshness-badge')
    expect(badge.dataset.phase).toBe(phase)
    expect(badge.textContent).toContain(label)
  })

  it('gives the four visible phases four different looks', () => {
    const classes = (['possibly-stale', 'queued', 'refreshing', 'failed'] as const).map(phase => {
      const { container } = render(<FreshnessBadge freshness={freshness({ phase })} />)
      const cls = container.querySelector('[data-testid="freshness-badge"] span')!.className
      cleanup()
      return cls
    })
    expect(new Set(classes).size).toBe(4)
  })

  it('spends cyan on refreshing and NOTHING else', () => {
    const { container: live } = render(<FreshnessBadge freshness={freshness({ phase: 'refreshing' })} />)
    expect(live.innerHTML).toContain('text-primary')
    expect(live.innerHTML).toContain('animate-spin')
    cleanup()
    for (const phase of ['possibly-stale', 'queued', 'failed'] as const) {
      const { container } = render(<FreshnessBadge freshness={freshness({ phase })} />)
      expect(container.innerHTML).not.toContain('text-primary')
      expect(container.innerHTML).not.toContain('animate-spin')
      cleanup()
    }
  })

  it('shows overdue as its OWN marker, even on a current surface', () => {
    // Orthogonal to the phase (R18): a Surface can be verified-then-gone-past-due,
    // and a Surface can be refreshing AND overdue. Folding one into the other would
    // let a retry loop paint over a deadline nobody met.
    render(<FreshnessBadge freshness={freshness({ overdue: true })} />)
    expect(screen.getByTestId('freshness-overdue')).toBeTruthy()
    cleanup()
    render(<FreshnessBadge freshness={freshness({ phase: 'refreshing', overdue: true })} />)
    expect(screen.getByTestId('freshness-badge').textContent).toContain('refreshing')
    expect(screen.getByTestId('freshness-overdue')).toBeTruthy()
  })
})

describe('freshnessTitle', () => {
  it('says WHY a surface is stale, not just that it is', () => {
    const title = freshnessTitle(freshness({
      phase: 'possibly-stale',
      staleReason: {
        kind: 'git-revision', key: 'k', detail: 'the worktree moved to a new revision',
        generation: 2, at: 1,
      },
    }))
    expect(title).toContain('the worktree moved to a new revision')
  })

  it('carries the failure message, so a failed surface is diagnosable in a hover', () => {
    const title = freshnessTitle(freshness({ phase: 'failed', failure: { message: 'no port available', at: 1 } }))
    expect(title).toContain('no port available')
  })

  it('appends the deadline note rather than replacing the phase note', () => {
    const title = freshnessTitle(freshness({ phase: 'queued', overdue: true }))
    expect(title).toContain('queued')
    expect(title).toContain('deadline has passed')
  })
})

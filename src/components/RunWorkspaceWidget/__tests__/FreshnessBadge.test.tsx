// @vitest-environment jsdom
//
// What a human can tell APART on the Slate (plan U6, R18). The point of the badge
// is not that it exists but that the five phases and the orthogonal overdue flag
// are visibly different from each other and from the resting state.
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { SurfaceFreshness } from '../../../types'
import { ClaimProblemNote, ClaimRefusalNote, FreshnessBadge, freshnessTitle } from '../FreshnessBadge'

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

// Scenario 6 (plan U7, KTD8). "The host could not check this" and "the host checked
// this and it held" are different facts, and a card that renders them the same makes
// a dead witness indistinguishable from a healthy one for the fifteen minutes it
// takes the stamp to amber.
describe('ClaimProblemNote — an unresolved claim', () => {
  it('renders nothing when every claim resolved — silence is the resting state', () => {
    render(<ClaimProblemNote id="s1" freshness={freshness({
      claimObservations: { c1: { value: 'landed', at: 10 } },
    })} />)
    expect(screen.queryByTestId('claim-problems-s1')).toBeNull()
  })

  it('renders nothing for a surface with no canonical record behind it', () => {
    render(<ClaimProblemNote id="s1" />)
    expect(screen.queryByTestId('claim-problems-s1')).toBeNull()
  })

  it('names the claim and the reason nobody could check it', () => {
    render(<ClaimProblemNote id="s1" freshness={freshness({
      claimObservations: {
        c1: { value: 'landed', at: 10 },
        c2: { at: 12, problem: { status: 'unresolved', detail: 'could not reach the remote' } },
      },
    })} />)
    const note = screen.getByTestId('claim-problems-s1')
    expect(note.textContent).toContain('c2')
    expect(note.textContent).toContain('could not reach the remote')
    // The claim that DID resolve is not listed — this note is about the gap.
    expect(note.textContent).not.toContain('c1')
  })

  it('distinguishes a broken witness from an unreachable one', () => {
    render(<ClaimProblemNote id="s1" freshness={freshness({
      claimObservations: {
        a: { at: 1, problem: { status: 'unresolved', detail: 'the host did not answer' } },
        b: { at: 2, problem: { status: 'failed', detail: 'the witness timed out' } },
      },
    })} />)
    const note = screen.getByTestId('claim-problems-s1')
    expect(note.textContent).toContain('2 claims not checked')
    const statuses = Array.from(note.querySelectorAll('li')).map(li => li.getAttribute('data-status'))
    expect(statuses).toEqual(['unresolved', 'failed'])
  })

  // A surface where the last look failed keeps its last known value (the observation
  // holds `value` and `problem` side by side, so a transient outage cannot fabricate a
  // change). The card must still say the last look failed.
  it('shows the problem even when a previous value is still stored', () => {
    render(<ClaimProblemNote id="s1" freshness={freshness({
      claimObservations: { c1: { value: 200, at: 10, problem: { status: 'unresolved', detail: 'connection refused' } } },
    })} />)
    expect(screen.getByTestId('claim-problems-s1').textContent).toContain('connection refused')
  })

  it('is amber, never rose — the surface is not wrong, one statement is unestablished', () => {
    const { container } = render(<ClaimProblemNote id="s1" freshness={freshness({
      claimObservations: { c1: { at: 1, problem: { status: 'failed', detail: 'x' } } },
    })} />)
    expect(container.innerHTML).toContain('amber')
    expect(container.innerHTML).not.toContain('rose')
    expect(container.innerHTML).not.toContain('text-primary')
  })

  // The two notes answer different questions — "I would not accept this declaration"
  // versus "I accepted it, looked, and could not tell" — so they must be separately
  // addressable and able to appear together on a doubly-broken card.
  it('is a different note from a refusal, and the two can coexist', () => {
    const both = freshness({
      claimRefusals: ['claim "c9" names an unknown witness kind "vibes".'],
      claimObservations: { c1: { at: 1, problem: { status: 'unresolved', detail: 'no network' } } },
    })
    render(<>
      <ClaimRefusalNote id="s1" freshness={both} />
      <ClaimProblemNote id="s1" freshness={both} />
    </>)
    expect(screen.getByTestId('claim-refusals-s1').textContent).toContain('vibes')
    expect(screen.getByTestId('claim-problems-s1').textContent).toContain('no network')
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

// ---------------------------------------------------------------------------
// What is KNOWN vs when it was last CHECKED (R3, KTD5).
//
// The phase says what the host is DOING. The check outcome says how the last look
// ENDED. They are different questions, and a Surface can be dirty because a check
// succeeded and found a change, or dirty because nothing could look at it at all. A
// reader who cannot tell those apart has no idea whether to wait or to act.
// ---------------------------------------------------------------------------

describe('the last completed check', () => {
  const check = (over: Partial<NonNullable<SurfaceFreshness['lastCheck']>> = {}) => ({
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_060_000,
    execution: 'host' as const,
    reason: 'its verification interval elapsed',
    targetGeneration: 3,
    outcome: 'succeeded' as const,
    ...over,
  })

  it('renders NOTHING for a successful check — the resting state is silence here too', () => {
    // Same discipline as `current`: a Slate where every card wears a green tick is a
    // Slate where nobody reads any of them.
    render(<FreshnessBadge freshness={freshness({ phase: 'possibly-stale', lastCheck: check() })} />)
    expect(screen.queryByTestId('freshness-last-check')).toBeNull()
  })

  it.each([
    ['failed', 'check failed'],
    ['unavailable', 'not checked'],
    ['superseded', 'moved again'],
  ] as const)('gives %s its own words', (outcome, label) => {
    render(<FreshnessBadge freshness={freshness({ phase: 'possibly-stale', lastCheck: check({ outcome }) })} />)
    const el = screen.getByTestId('freshness-last-check')
    expect(el.dataset.outcome).toBe(outcome)
    expect(el.textContent).toContain(label)
  })

  it('the three non-success outcomes are visually distinct from each other', () => {
    const looks = (['failed', 'unavailable', 'superseded'] as const).map(outcome => {
      cleanup()
      render(<FreshnessBadge freshness={freshness({ phase: 'possibly-stale', lastCheck: check({ outcome }) })} />)
      return screen.getByTestId('freshness-last-check').className
    })
    expect(new Set(looks).size).toBe(3)
  })

  it('a DIRTY surface whose check succeeded reads differently from one nothing could check', () => {
    // The distinction the whole two-field split exists for. Both are stale; only one
    // of them means "the host cannot tell you anything".
    const succeeded = freshnessTitle(freshness({ phase: 'possibly-stale', lastCheck: check() }))
    const unavailable = freshnessTitle(freshness({
      phase: 'possibly-stale',
      lastCheck: check({ outcome: 'unavailable', detail: 'its foreground agent is not running' }),
    }))
    expect(succeeded).toMatch(/last confirmed this at/)
    expect(unavailable).toMatch(/Nothing could check this at/)
    expect(unavailable).toContain('its foreground agent is not running')
    expect(succeeded).not.toBe(unavailable)
  })

  it('says plainly when the host has never finished a check, rather than reassuring', () => {
    expect(freshnessTitle(freshness({ lastCheck: null }))).toMatch(/has not finished a check/)
  })

  it('names WHO checked, so a machine check reads differently from an agent rebuild', () => {
    const byHost = freshnessTitle(freshness({ lastCheck: check({ execution: 'host' }) }))
    const byOwner = freshnessTitle(freshness({ lastCheck: check({ execution: 'owner' }) }))
    expect(byHost).toMatch(/A machine check/)
    expect(byOwner).toMatch(/Its foreground agent/)
  })
})

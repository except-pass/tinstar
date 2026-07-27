// @vitest-environment jsdom
//
// U1e — the client half of "a faulted load renders legacy Slate content behind
// the degraded marker and never presents it as current".
//
// The server side (canonical projection stays empty, both snapshot files stay
// byte-untouched) is asserted in `document-store-surface-wiring.test.ts`. What
// only the client can prove is the other half of the plan's sentence: that the
// frozen legacy copy is visible AND labelled, rather than either hidden or
// silently passed off as current.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { SurfaceHealthStatus } from '../../../domain/types'

let health: SurfaceHealthStatus = { health: 'healthy' }
vi.mock('../../../hooks/useServerEvents', () => ({
  useSurfaceHealth: () => health,
}))

import { SurfaceDegradedBanner } from '../SurfaceDegradedBanner'

afterEach(cleanup)

describe('SurfaceDegradedBanner', () => {
  it('renders nothing on a healthy store', () => {
    health = { health: 'healthy' }
    const { container } = render(<SurfaceDegradedBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  // `recovered` means the BACKUP supplied current records — nothing on screen is
  // stale. A warning there would train the user to ignore the one that matters.
  it('renders nothing on a recovered store', () => {
    health = { health: 'recovered' }
    const { container } = render(<SurfaceDegradedBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the frozen snapshot time and offers no way to dismiss it', () => {
    const frozenAt = '2026-07-20T09:30:00.000Z'
    health = { health: 'faulted-read-only', frozenAt, detail: 'primary unparsable, backup missing' }
    render(<SurfaceDegradedBanner />)

    const marker = screen.getByTestId('surface-degraded-marker')
    // Explicit: it says the content is not current, in those words.
    expect(marker.textContent).toMatch(/Not current/i)
    // And it NAMES a time, because "frozen" with no date reads as a transient
    // glitch rather than as work that may be days old.
    expect(marker.textContent).toContain(new Date(frozenAt).toLocaleString())
    expect(marker.textContent).toContain('primary unparsable, backup missing')
    // Non-dismissable: no ✕, no button, nothing that removes it for the session.
    expect(marker.querySelector('button')).toBeNull()
  })

  it('still says "not current" when the frozen time is unreadable', () => {
    health = { health: 'faulted-read-only' }
    render(<SurfaceDegradedBanner />)
    const marker = screen.getByTestId('surface-degraded-marker')
    expect(marker.textContent).toMatch(/Not current/i)
    // No fabricated date — an unknown time is stated as unknown.
    expect(marker.textContent).toContain('an unknown time')
  })
})

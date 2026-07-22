// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SurfaceAge, SLATE_STALE_AFTER_MS } from '../SurfaceAge'

const NOW = 1_000_000_000_000

describe('SurfaceAge', () => {
  it('shows humanized recent time and is not stale', () => {
    render(<SurfaceAge amendedAt={NOW - 3 * 60_000} now={NOW} />)
    const el = screen.getByTestId('surface-age')
    expect(el.textContent).toBe('updated 3m ago')
    expect(el.getAttribute('data-stale')).toBeNull()
  })

  it('reads "just now" under a minute', () => {
    render(<SurfaceAge amendedAt={NOW - 5_000} now={NOW} />)
    expect(screen.getByTestId('surface-age').textContent).toBe('updated just now')
  })

  it('marks stale past the session horizon', () => {
    render(<SurfaceAge amendedAt={NOW - (SLATE_STALE_AFTER_MS + 60_000)} now={NOW} />)
    expect(screen.getByTestId('surface-age').getAttribute('data-stale')).toBe('true')
  })

  it('renders nothing for a non-finite timestamp (no "NaN ago")', () => {
    const { container } = render(<SurfaceAge amendedAt={Number.NaN} now={NOW} />)
    expect(container.querySelector('[data-testid="surface-age"]')).toBeNull()
  })
})

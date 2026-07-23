// @vitest-environment jsdom
//
// R4 — the lazy `mermaid-*.js` chunk fails to load (e.g. a stale /assets/*.js
// after a rebuild). This needs the 'mermaid' module ITSELF to reject, and
// vi.mock's factory result is cached per test file — so this scenario gets its
// own file where the factory throws unconditionally, rather than a flag the
// sibling file's cached factory would never re-read.
//
// Without the dynamic-import `.catch` in MermaidComponent, this hangs on
// "Rendering diagram…" forever. That is the bug this file guards.
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MermaidComponent } from '../MermaidComponent'

vi.mock('mermaid', () => {
  throw new Error('Failed to fetch dynamically imported module')
})

describe('MermaidComponent — mermaid chunk fails to load (R4)', () => {
  it('degrades to an inline notice with a reload hint instead of hanging on the placeholder', async () => {
    const { container } = render(<MermaidComponent source={'graph TD; A-->B'} />)

    await waitFor(() => {
      expect(container.textContent).toContain("couldn't load the diagram renderer")
    })
    expect(container.textContent).toContain('try reloading the page')
    // Carries the underlying failure detail in parens so it stays diagnosable.
    // (The literal text is vitest's own mock-failure message, not the browser's
    // "Failed to fetch dynamically imported module" — assert the shape, not the
    // wording, so this doesn't break on a vitest upgrade.)
    expect(container.textContent).toMatch(
      /couldn't load the diagram renderer \(.+\) — try reloading the page/,
    )
    expect(container.textContent).not.toContain('(unknown error)')
    // It degraded — it did not sit on the loading placeholder forever.
    expect(screen.queryByText('Rendering diagram...')).toBeNull()

    // Same inline amber degrade styling as every other A2UI node fallback.
    const line = container.firstElementChild as HTMLElement
    expect(line.className).toContain('text-amber-300/80')
  })
})

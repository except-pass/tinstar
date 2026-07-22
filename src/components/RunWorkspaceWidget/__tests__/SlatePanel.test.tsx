// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'
import type { A2uiContent, SlateSurface } from '../../../types'
import { MALFORMED_SIGNAL } from '../../../a2ui/A2uiRenderer'

// apiFetch is the single HTTP seam (never bare fetch — it 404s in Tauri). Mock it so
// the refresh POSTs are observable and the delivered/timeout paths are deterministic.
const apiFetch = vi.fn()
vi.mock('../../../apiClient', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiUrl: (p: string) => p,
}))

import { SlatePanel } from '../SlatePanel'
import { REFRESH_MAX_MS } from '../slateRefresh'
import { getHiddenSlateSurfaces, familyKeys } from '../../../lib/uiPrefs'

/** A resolved refresh/compose response envelope, matching the server shape. */
function okDelivered(delivered: boolean) {
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, data: { delivered } }) } as unknown as Response)
}

/** Build an A2UI content envelope from a flat component list. */
function content(components: A2uiContent['components'], root?: string): A2uiContent {
  return { root: root ?? (components[0]?.id as string), components }
}

/** A minimal, valid surface carrying a single Text body. */
function surface(id: string, text: string, extra: Partial<SlateSurface> = {}): SlateSurface {
  return {
    id,
    author: 'agent',
    kind: 'diagram',
    body: content([{ id: 'root', component: 'Text', text, variant: 'body' }]),
    createdAt: 1,
    amendedAt: 1,
    ...extra,
  }
}

describe('SlatePanel (U5)', () => {
  it('renders nothing when the slate is empty or absent', () => {
    const { container: empty } = render(<SlatePanel runId="run-1" surfaces={[]} />)
    expect(empty.firstChild).toBeNull()

    const { container: absent } = render(<SlatePanel runId="run-1" />)
    expect(absent.firstChild).toBeNull()
  })

  it('renders a valid surface A2UI body', () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'Open point: pick a name')]} />)
    expect(screen.getByText('Open point: pick a name')).toBeTruthy()
    // The scroll body carries data-scrollable so the canvas wheel handler yields.
    expect(document.querySelector('[data-scrollable]')).not.toBeNull()
  })

  it('degrades a malformed surface WITHOUT affecting a sibling (per-surface boundary)', () => {
    // A body whose `root` references a non-existent component → the renderer
    // degrades this surface to the readable fallback.
    const malformed: SlateSurface = {
      id: 'bad',
      author: 'agent',
      kind: 'diagram',
      body: { root: 'missing', components: [] },
      createdAt: 1,
      amendedAt: 1,
    }
    const healthy = surface('good', 'I still render', { createdAt: 2 })

    render(<SlatePanel runId="run-1" surfaces={[malformed, healthy]} />)

    // The malformed surface shows the degrade signal...
    expect(screen.getByText(new RegExp(MALFORMED_SIGNAL))).toBeTruthy()
    // ...and its sibling is entirely unaffected.
    expect(screen.getByText('I still render')).toBeTruthy()
  })

  it('sorts surfaces by order then createdAt', () => {
    render(
      <SlatePanel
        runId="run-1"
        surfaces={[
          surface('c', 'gamma', { order: 2, createdAt: 1 }),
          surface('a', 'alpha', { order: 1, createdAt: 5 }),
          surface('b', 'beta', { order: 1, createdAt: 1 }),
        ]}
      />,
    )
    const rendered = screen.getByText('alpha').closest('[data-testid^="slate-surface-"]')
    const scroll = document.querySelector('[data-scrollable]')!
    const ids = Array.from(scroll.querySelectorAll('[data-testid^="slate-surface-"]')).map(
      (el) => el.getAttribute('data-testid'),
    )
    // order 1 (createdAt 1 before 5) then order 2.
    expect(ids).toEqual(['slate-surface-b', 'slate-surface-a', 'slate-surface-c'])
    expect(rendered).not.toBeNull()
  })
})

describe('SlatePanel reflow (U1/R2)', () => {
  it('renders one grid column for a narrow (or unset) width', () => {
    const { container } = render(
      <SlatePanel runId="run-1" surfaces={[surface('s1', 'a')]} width={300} />,
    )
    const scroll = container.querySelector('[data-scrollable]')!
    expect(scroll.className).toContain('grid-cols-1')
    expect(scroll.className).not.toContain('grid-cols-2')
    expect(scroll.getAttribute('data-columns')).toBe('1')

    // No width prop → still single-column.
    cleanup()
    const { container: c2 } = render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'a')]} />)
    expect(c2.querySelector('[data-scrollable]')!.getAttribute('data-columns')).toBe('1')
  })

  it('renders two grid columns for a wide width', () => {
    const { container } = render(
      <SlatePanel runId="run-1" surfaces={[surface('s1', 'a')]} width={500} />,
    )
    const scroll = container.querySelector('[data-scrollable]')!
    expect(scroll.className).toContain('grid-cols-2')
    expect(scroll.getAttribute('data-columns')).toBe('2')
    // The #126 layout guards must survive the grid switch.
    expect(scroll.className).toContain('overflow-x-hidden')
    expect(scroll.className).toContain('[overflow-wrap:anywhere]')
  })
})

describe('SlatePanel hide surfaces (U2/R4)', () => {
  beforeEach(() => {
    localStorage.clear()
    cleanup()
  })

  it('hides a surface, removing it from the render and persisting the id', () => {
    const surfaces = [surface('keep', 'keep me'), surface('drop', 'drop me')]
    render(<SlatePanel runId="run-1" surfaces={surfaces} />)

    expect(screen.getByText('drop me')).toBeTruthy()
    fireEvent.click(screen.getByTestId('hide-surface-drop'))

    // Removed from the render...
    expect(screen.queryByText('drop me')).toBeNull()
    expect(screen.getByText('keep me')).toBeTruthy()
    // ...and persisted to the per-browser set.
    expect([...getHiddenSlateSurfaces()]).toContain('drop')
    expect(localStorage.getItem(familyKeys.hiddenSlateSurfaces)).toContain('drop')
  })

  it('shows the correct hidden count and reveals hidden surfaces via the toggle', () => {
    const surfaces = [surface('a', 'alpha'), surface('b', 'beta'), surface('c', 'gamma')]
    render(<SlatePanel runId="run-1" surfaces={surfaces} />)

    fireEvent.click(screen.getByTestId('hide-surface-a'))
    fireEvent.click(screen.getByTestId('hide-surface-b'))

    // Header reflects two hidden.
    const toggle = screen.getByTestId('slate-hidden-toggle')
    expect(toggle.textContent).toContain('2 hidden')
    expect(toggle.textContent).toContain('show')
    expect(screen.queryByText('alpha')).toBeNull()

    // Reveal → the hidden surfaces come back (dimmed) with an unhide affordance.
    fireEvent.click(toggle)
    expect(screen.getByText('alpha')).toBeTruthy()
    expect(screen.getByTestId('unhide-surface-a')).toBeTruthy()
    expect(screen.getByTestId('slate-hidden-toggle').textContent).toContain('hide')

    // Unhide restores it fully.
    fireEvent.click(screen.getByTestId('unhide-surface-a'))
    expect([...getHiddenSlateSurfaces()]).not.toContain('a')
  })

  it('keeps a surface hidden across a re-render that still carries it in run.slate', () => {
    const surfaces = [surface('a', 'alpha'), surface('b', 'beta')]
    const { rerender } = render(<SlatePanel runId="run-1" surfaces={surfaces} />)

    fireEvent.click(screen.getByTestId('hide-surface-a'))
    expect(screen.queryByText('alpha')).toBeNull()

    // Simulate an SSE re-projection: the SAME surface list (a still present) is
    // pushed again. The client-side filter must NOT resurrect the hidden surface.
    rerender(<SlatePanel runId="run-1" surfaces={[...surfaces]} />)
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByText('beta')).toBeTruthy()
  })

  it('seeds the hidden set from persisted prefs on mount', () => {
    localStorage.setItem(familyKeys.hiddenSlateSurfaces, JSON.stringify(['a']))
    render(<SlatePanel runId="run-1" surfaces={[surface('a', 'alpha'), surface('b', 'beta')]} />)
    // 'a' was hidden in a prior session → not rendered; toggle shows 1 hidden.
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByTestId('slate-hidden-toggle').textContent).toContain('1 hidden')
  })
})

describe('SlatePanel refresh (U3)', () => {
  beforeEach(() => {
    localStorage.clear()
    cleanup()
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => okDelivered(true))
  })

  it('clicking a surface ⟳ marks it refreshing and POSTs the refresh', async () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'x')]} />)
    fireEvent.click(screen.getByTestId('refresh-surface-s1'))

    // Optimistic: the spinner shows at once (before the round trip).
    expect(screen.getByTestId('refresh-surface-s1').getAttribute('data-refreshing')).toBe('true')
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runs/run-1/slate/surfaces/s1/refresh',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })

  it('clears the refreshing state when a newer surface.amendedAt arrives', async () => {
    const { rerender } = render(
      <SlatePanel runId="run-1" surfaces={[surface('s1', 'x', { amendedAt: 1 })]} />,
    )
    fireEvent.click(screen.getByTestId('refresh-surface-s1'))
    expect(screen.getByTestId('refresh-surface-s1').getAttribute('data-refreshing')).toBe('true')

    // Simulate the re-authored surface arriving over the SSE run delta (newer amendedAt).
    rerender(<SlatePanel runId="run-1" surfaces={[surface('s1', 'x', { amendedAt: 2 })]} />)
    await waitFor(() =>
      expect(screen.getByTestId('refresh-surface-s1').getAttribute('data-refreshing')).toBeNull(),
    )
  })

  it('clears a stuck spinner after the refresh timeout elapses', () => {
    vi.useFakeTimers()
    try {
      // A POST that never resolves → only the timeout can clear the spinner.
      apiFetch.mockImplementation(() => new Promise<never>(() => {}))
      render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'x')]} />)
      fireEvent.click(screen.getByTestId('refresh-surface-s1'))
      expect(screen.getByTestId('refresh-surface-s1').getAttribute('data-refreshing')).toBe('true')

      act(() => {
        vi.advanceTimersByTime(REFRESH_MAX_MS)
      })
      expect(screen.getByTestId('refresh-surface-s1').getAttribute('data-refreshing')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the unreachable note and clears the spinner on delivered:false', async () => {
    apiFetch.mockImplementation(() => okDelivered(false))
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'x')]} />)
    fireEvent.click(screen.getByTestId('refresh-surface-s1'))

    await waitFor(() => expect(screen.getByTestId('refresh-unreachable-s1')).toBeTruthy())
    // Don't spin on a dead run — the spinner is cleared immediately.
    expect(screen.getByTestId('refresh-surface-s1').getAttribute('data-refreshing')).toBeNull()
  })

  it('Refresh all POSTs for each visible surface and shows the Slate-level loading state', async () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('a', 'x'), surface('b', 'y')]} />)
    fireEvent.click(screen.getByTestId('slate-refresh-all'))

    // Slate-level loading state (each surface keeps spinning on delivered:true).
    expect(screen.getByTestId('slate-refreshing-all')).toBeTruthy()
    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runs/run-1/slate/surfaces/a/refresh',
        expect.objectContaining({ method: 'POST' }),
      )
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runs/run-1/slate/surfaces/b/refresh',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })
})

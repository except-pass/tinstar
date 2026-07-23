// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRef } from 'react'
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

import { SlatePanel, type SlatePanelHandle } from '../SlatePanel'
import { SLATE_HOTKEYS } from '../slateHotkeys'
import { REFRESH_MAX_MS } from '../slateRefresh'
import { getHiddenSlateSurfaces, addHiddenSlateSurface, getMinimizedSlateSurfaces, familyKeys } from '../../../lib/uiPrefs'

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
    // `[data-columns]` names the grid unambiguously — `[data-scrollable]` is shared with
    // the pinned objective's prose block, which sits earlier in the tree.
    const scroll = document.querySelector('[data-columns]')!
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
    const scroll = container.querySelector('[data-columns]')!
    expect(scroll.className).toContain('grid-cols-1')
    expect(scroll.className).not.toContain('grid-cols-2')
    expect(scroll.getAttribute('data-columns')).toBe('1')

    // No width prop → still single-column.
    cleanup()
    const { container: c2 } = render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'a')]} />)
    expect(c2.querySelector('[data-columns]')!.getAttribute('data-columns')).toBe('1')
  })

  it('renders two grid columns for a wide width', () => {
    const { container } = render(
      <SlatePanel runId="run-1" surfaces={[surface('s1', 'a')]} width={500} />,
    )
    const scroll = container.querySelector('[data-columns]')!
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

describe('SlatePanel keyboard surface (S6 U1)', () => {
  beforeEach(() => {
    localStorage.clear()
    cleanup()
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => okDelivered(true))
  })

  /** Render with a ref so we can drive the imperative handle the widget drives. */
  function renderWithHandle(surfaces: SlateSurface[], props: Record<string, unknown> = {}) {
    const ref = createRef<SlatePanelHandle>()
    render(<SlatePanel ref={ref} runId="run-1" surfaces={surfaces} {...props} />)
    return ref
  }

  const focusedId = () =>
    document.querySelector('[data-focused="true"]')?.getAttribute('data-testid') ?? null

  it('j / k walk the focus ring across surfaces and clamp at the ends', () => {
    const ref = renderWithHandle([surface('a', 'alpha'), surface('b', 'beta'), surface('c', 'gamma')])
    expect(focusedId()).toBeNull()

    // First press lands on the first row rather than moving from nowhere.
    act(() => ref.current!.focusNext())
    expect(focusedId()).toBe('slate-surface-a')
    act(() => ref.current!.focusNext())
    expect(focusedId()).toBe('slate-surface-b')
    act(() => ref.current!.focusPrev())
    expect(focusedId()).toBe('slate-surface-a')

    // Clamp, don't wrap — running off the top stays at the top.
    act(() => ref.current!.focusPrev())
    expect(focusedId()).toBe('slate-surface-a')
    act(() => { ref.current!.focusNext(); ref.current!.focusNext(); ref.current!.focusNext() })
    expect(focusedId()).toBe('slate-surface-c')
  })

  it('walks open-point ROWS too, in the order they render', () => {
    const points = [
      surface('p1', '', { kind: 'open-point', headline: 'first', status: 'open' }),
      surface('p2', '', { kind: 'open-point', headline: 'second', status: 'open' }),
    ]
    const ref = renderWithHandle([...points, surface('card', 'a card', { createdAt: 9 })])

    act(() => ref.current!.focusNext())
    expect(focusedId()).toBe('point-p1')
    act(() => ref.current!.focusNext())
    expect(focusedId()).toBe('point-p2')
    act(() => ref.current!.focusNext())
    expect(focusedId()).toBe('slate-surface-card')
  })

  // S4: a workbenched point is NOT a row — it renders as a column inside a band, with
  // no focus ring and none of the x/r chrome the ring implies. j/k must step straight
  // over it. BACK-OUT GUARD: drop `partitionWorkbenches` from `focusRows` and the ring
  // lands on `point-g1`, which isn't in the document.
  it('j / k skip points swallowed by a workbench', () => {
    const ref = renderWithHandle([
      surface('p1', '', { kind: 'open-point', headline: 'first', status: 'open' }),
      surface('g1', '', { kind: 'open-point', headline: 'q one', status: 'open', group: 'qs' }),
      surface('g2', '', { kind: 'open-point', headline: 'q two', status: 'open', group: 'qs' }),
      surface('p2', '', { kind: 'open-point', headline: 'last', status: 'open' }),
    ])

    // The band exists and the grouped points are not rows.
    expect(screen.getByTestId('workbench-qs')).toBeTruthy()
    expect(screen.queryByTestId('point-g1')).toBeNull()

    act(() => ref.current!.focusNext())
    expect(focusedId()).toBe('point-p1')
    act(() => ref.current!.focusNext())
    expect(focusedId()).toBe('point-p2')
    // Clamped at the end — traversal never strands focus on an invisible column.
    act(() => ref.current!.focusNext())
    expect(focusedId()).toBe('point-p2')
  })

  // The OTHER half of the same change: `hidden` is the exclusion set, so a revealed
  // hidden grouped point drops OUT of the band and back into the row list — and must
  // therefore be reachable by j/k again. BACK-OUT GUARD: drop the second argument at
  // the `partitionWorkbenches` call in `focusRows` and this fails — OpenPointsSurface
  // still renders the hidden point as a row, but j/k steps straight past it and x/r
  // can never reach it.
  it('j / k still reach a revealed hidden point that a workbench let go', () => {
    const qs = [
      surface('g1', '', { kind: 'open-point', headline: 'q one', status: 'open', group: 'qs' }),
      surface('h1', '', { kind: 'open-point', headline: 'hidden q', status: 'open', group: 'qs' }),
      surface('g2', '', { kind: 'open-point', headline: 'q two', status: 'open', group: 'qs' }),
    ]
    const ref = renderWithHandle(qs)

    // All three grouped and visible → all three are columns, so there is no row to
    // focus at all.
    act(() => ref.current!.focusNext())
    expect(focusedId()).toBeNull()

    // Hide the middle question (it has no ✕ of its own while it's a column, which is
    // the whole point), then remount and reveal hidden surfaces.
    cleanup()
    addHiddenSlateSurface('h1')
    const ref2 = renderWithHandle(qs)
    fireEvent.click(screen.getByTestId('slate-hidden-toggle'))

    // The band keeps the two live ones; the hidden one is back to being a row.
    expect(screen.getByTestId('workbench-column-g1')).toBeTruthy()
    expect(screen.queryByTestId('workbench-column-h1')).toBeNull()
    expect(screen.getByTestId('point-h1')).toBeTruthy()

    // ...and j/k must reach it, or x/r could never act on a visible row.
    act(() => ref2.current!.focusNext())
    expect(focusedId()).toBe('point-h1')
  })

  it('x hides the focused surface and moves focus to the next row', () => {
    const ref = renderWithHandle([surface('a', 'alpha'), surface('b', 'beta')])
    act(() => ref.current!.focusNext())
    expect(focusedId()).toBe('slate-surface-a')

    act(() => ref.current!.hideFocused())
    expect(screen.queryByText('alpha')).toBeNull()
    expect([...getHiddenSlateSurfaces()]).toContain('a')
    expect(focusedId()).toBe('slate-surface-b')
  })

  it('r refreshes the focused surface (and nothing when nothing is focused)', async () => {
    const ref = renderWithHandle([surface('a', 'alpha'), surface('b', 'beta')])

    act(() => ref.current!.refreshFocused())
    expect(apiFetch).not.toHaveBeenCalled()

    act(() => ref.current!.focusNext())
    act(() => ref.current!.refreshFocused())
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/runs/run-1/slate/surfaces/a/refresh',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })

  it('c opens the composer popover, and on a blank Slate focuses the inline one', () => {
    const ref = renderWithHandle([surface('a', 'alpha')])
    expect(screen.queryByTestId('slate-composer')).toBeNull()
    act(() => ref.current!.openComposer())
    expect(screen.getByTestId('slate-composer')).toBeTruthy()

    // Blank Slate: the composer is already inline (U5), so `c` puts the cursor in it
    // instead of stacking a second one on top.
    cleanup()
    const blank = renderWithHandle([], { open: true })
    act(() => blank.current!.openComposer())
    expect(screen.getAllByTestId('slate-composer')).toHaveLength(1)
    expect(document.activeElement).toBe(screen.getByTestId('composer-search'))
  })

  it('/ opens the search field, which filters the rendered surfaces', () => {
    const ref = renderWithHandle([
      surface('a', 'alpha', { headline: 'Deploy checklist' }),
      surface('b', 'beta', { headline: 'Dataflow' }),
    ])
    expect(screen.queryByTestId('slate-search')).toBeNull()

    act(() => ref.current!.focusSearch())
    const search = screen.getByTestId('slate-search')

    fireEvent.change(search, { target: { value: 'deploy' } })
    expect(screen.getByTestId('slate-surface-a')).toBeTruthy()
    expect(screen.queryByTestId('slate-surface-b')).toBeNull()

    // A miss says so instead of looking like an empty Slate.
    fireEvent.change(search, { target: { value: 'zzz' } })
    expect(screen.getByTestId('slate-no-matches')).toBeTruthy()

    // Esc clears the filter and closes the field.
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(screen.queryByTestId('slate-search')).toBeNull()
    expect(screen.getByTestId('slate-surface-b')).toBeTruthy()
  })

  it('? toggles the cheatsheet ONLY while the Slate zone is focused', () => {
    // Not focused → the panel must not touch `?`; the global command palette owns it.
    const { rerender } = render(<SlatePanel runId="run-1" surfaces={[surface('a', 'x')]} />)
    fireEvent.keyDown(window, { code: 'Slash', key: '?', shiftKey: true })
    expect(screen.queryByTestId('slate-cheatsheet')).toBeNull()

    rerender(<SlatePanel runId="run-1" surfaces={[surface('a', 'x')]} focused />)
    fireEvent.keyDown(window, { code: 'Slash', key: '?', shiftKey: true })
    expect(screen.getByTestId('slate-cheatsheet')).toBeTruthy()
    // Every key the Slate answers to is listed.
    for (const h of SLATE_HOTKEYS) {
      expect(screen.getByTestId('slate-cheatsheet').textContent).toContain(h.label)
    }

    // …and `?` again closes it.
    fireEvent.keyDown(window, { code: 'Slash', key: '?', shiftKey: true })
    expect(screen.queryByTestId('slate-cheatsheet')).toBeNull()
  })

  it('the ? shim stops the event so the global command palette never sees it', () => {
    // The palette listens on a bubble-phase window listener. Ours is capture-phase +
    // stopImmediatePropagation, so a later listener must not run.
    const palette = vi.fn()
    window.addEventListener('keydown', palette)
    try {
      render(<SlatePanel runId="run-1" surfaces={[surface('a', 'x')]} focused />)
      fireEvent.keyDown(window, { code: 'Slash', key: '?', shiftKey: true })
      expect(screen.getByTestId('slate-cheatsheet')).toBeTruthy()
      expect(palette).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', palette)
    }
  })

  it('the ? shim stands down while an input has focus', () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('a', 'x')]} focused />)
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    try {
      fireEvent.keyDown(window, { code: 'Slash', key: '?', shiftKey: true })
      expect(screen.queryByTestId('slate-cheatsheet')).toBeNull()
    } finally {
      input.remove()
    }
  })

  it('Esc and an outside click dismiss the cheatsheet', () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('a', 'x')]} focused />)
    fireEvent.keyDown(window, { code: 'Slash', key: '?', shiftKey: true })
    expect(screen.getByTestId('slate-cheatsheet')).toBeTruthy()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByTestId('slate-cheatsheet')).toBeNull()

    fireEvent.keyDown(window, { code: 'Slash', key: '?', shiftKey: true })
    fireEvent.click(screen.getByTestId('slate-cheatsheet'))
    expect(screen.queryByTestId('slate-cheatsheet')).toBeNull()
  })

  it('closes the cheatsheet when the Slate zone loses focus', () => {
    // Otherwise the overlay is stranded: its `?` toggle has unmounted, so `?` would
    // open the command palette BEHIND it — and its capture-phase Esc handler would
    // go on swallowing Escape for the whole app.
    const { rerender } = render(<SlatePanel runId="run-1" surfaces={[surface('a', 'x')]} focused />)
    fireEvent.keyDown(window, { code: 'Slash', key: '?', shiftKey: true })
    expect(screen.getByTestId('slate-cheatsheet')).toBeTruthy()

    rerender(<SlatePanel runId="run-1" surfaces={[surface('a', 'x')]} />)
    expect(screen.queryByTestId('slate-cheatsheet')).toBeNull()

    // …and with the overlay gone, Escape reaches whoever else wants it.
    const other = vi.fn()
    window.addEventListener('keydown', other)
    try {
      fireEvent.keyDown(window, { key: 'Escape' })
      expect(other).toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', other)
    }
  })

  it('searches the RENDERED body text, not just the fields the card never shows', () => {
    // An expanded card never renders `headline` — the visible title is whatever the
    // agent put in the A2UI body. A haystack of headline/id/kind alone means typing
    // a word plainly visible on a card matches nothing.
    const ref = renderWithHandle([
      surface('a', 'the rollback plan for staging', { headline: 'zzz-invisible' }),
      surface('b', 'unrelated prose'),
    ])
    act(() => ref.current!.focusSearch())
    fireEvent.change(screen.getByTestId('slate-search'), { target: { value: 'rollback' } })

    expect(screen.getByTestId('slate-surface-a')).toBeTruthy()
    expect(screen.queryByTestId('slate-surface-b')).toBeNull()
  })

  it('x cannot hide a surface the filter has removed from the view', () => {
    const ref = renderWithHandle([surface('a', 'alpha'), surface('b', 'beta')])
    act(() => ref.current!.focusNext())
    expect(focusedId()).toBe('slate-surface-a')

    // Filter 'a' out of the view. Its focus is now stale, so x must be inert rather
    // than hiding something invisible.
    act(() => ref.current!.focusSearch())
    fireEvent.change(screen.getByTestId('slate-search'), { target: { value: 'beta' } })
    act(() => ref.current!.hideFocused())

    expect([...getHiddenSlateSurfaces()]).toEqual([])
  })

  it('x on the LAST row falls back to the previous one', () => {
    const ref = renderWithHandle([surface('a', 'alpha'), surface('b', 'beta')])
    act(() => { ref.current!.focusNext(); ref.current!.focusNext() })
    expect(focusedId()).toBe('slate-surface-b')

    act(() => ref.current!.hideFocused())
    expect(focusedId()).toBe('slate-surface-a')
  })
})

describe('SlatePanel minimize surfaces (S6 U3)', () => {
  beforeEach(() => {
    localStorage.clear()
    cleanup()
  })

  it('collapses the body to a title but keeps the card, then restores', () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'the body', { headline: 'A surface' })]} />)
    expect(screen.getByText('the body')).toBeTruthy()

    fireEvent.click(screen.getByTestId('minimize-surface-s1'))

    // The card is still in its slot, marked minimized, showing only its title.
    const card = screen.getByTestId('slate-surface-s1')
    expect(card.getAttribute('data-minimized')).toBe('true')
    expect(screen.getByTestId('slate-minimized-title-s1').textContent).toBe('A surface')
    expect(screen.queryByText('the body')).toBeNull()

    // Restore brings the body back.
    fireEvent.click(screen.getByTestId('restore-surface-s1'))
    expect(screen.getByText('the body')).toBeTruthy()
    expect(screen.getByTestId('slate-surface-s1').getAttribute('data-minimized')).toBeNull()
  })

  it('persists the minimized set per browser and seeds from it on mount', () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'body one')]} />)
    fireEvent.click(screen.getByTestId('minimize-surface-s1'))
    expect([...getMinimizedSlateSurfaces('run-1')]).toContain('s1')
    expect(localStorage.getItem(familyKeys.minimizedSlateSurfaces)).toContain('s1')

    // A fresh mount reads the pref back.
    cleanup()
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'body one')]} />)
    expect(screen.getByTestId('slate-surface-s1').getAttribute('data-minimized')).toBe('true')
    expect(screen.queryByText('body one')).toBeNull()
  })

  it('does NOT collapse the same surface id on a different run', () => {
    // Surface ids come from the author's file and the contract asks for a stable
    // slug, so generic ids (`decisions`, `blockers`) recur across runs by design.
    // An un-scoped pref would collapse every run's copy on its next mount.
    render(<SlatePanel runId="run-A" surfaces={[surface('decisions', 'A body')]} />)
    fireEvent.click(screen.getByTestId('minimize-surface-decisions'))
    expect(screen.queryByText('A body')).toBeNull()

    cleanup()
    render(<SlatePanel runId="run-B" surfaces={[surface('decisions', 'B body')]} />)
    expect(screen.getByText('B body')).toBeTruthy()
    expect(screen.getByTestId('slate-surface-decisions').getAttribute('data-minimized')).toBeNull()
  })

  it('is distinct from hide — minimize keeps the card, hide removes it', () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('a', 'alpha'), surface('b', 'beta')]} />)

    fireEvent.click(screen.getByTestId('minimize-surface-a'))
    fireEvent.click(screen.getByTestId('hide-surface-b'))

    // Minimized: present, collapsed. Hidden: gone entirely.
    expect(screen.getByTestId('slate-surface-a')).toBeTruthy()
    expect(screen.queryByTestId('slate-surface-b')).toBeNull()
    // The two prefs are separate stores — neither leaks into the other.
    expect([...getMinimizedSlateSurfaces('run-1')]).toEqual(['a'])
    expect([...getHiddenSlateSurfaces()]).toEqual(['b'])
  })

  it('hide WINS when a surface is somehow in both sets', () => {
    // `isMinimized` carries an `&& !isHidden` clause. Without it, a revealed hidden
    // surface would render as a collapsed row instead of its dimmed body, and the
    // unhide affordance would be the only thing left to look at.
    localStorage.setItem(familyKeys.hiddenSlateSurfaces, JSON.stringify(['a']))
    localStorage.setItem(
      familyKeys.minimizedSlateSurfaces,
      JSON.stringify([`run-1\u001Fa`]),
    )
    render(<SlatePanel runId="run-1" surfaces={[surface('a', 'alpha'), surface('b', 'beta')]} />)

    fireEvent.click(screen.getByTestId('slate-hidden-toggle'))
    const card = screen.getByTestId('slate-surface-a')
    expect(card.getAttribute('data-minimized')).toBeNull()
    expect(screen.getByText('alpha')).toBeTruthy()
    // A hidden surface offers unhide only — no minimize control to confuse it with.
    expect(screen.queryByTestId('minimize-surface-a')).toBeNull()
    expect(screen.getByTestId('unhide-surface-a')).toBeTruthy()
  })

  it('keeps the refresh pulse and its failure note reachable while minimized', async () => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => okDelivered(false)) // the run is asleep
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'body', { headline: 'S1' })]} />)
    fireEvent.click(screen.getByTestId('minimize-surface-s1'))

    fireEvent.click(screen.getByTestId('refresh-surface-s1'))
    // The pulse lives on the SHELL, so a collapsed card still shows work in flight.
    const card = screen.getByTestId('slate-surface-s1')
    expect(card.getAttribute('data-minimized')).toBe('true')
    expect(card.getAttribute('data-refreshing')).toBe('true')
    expect(card.className).toContain('slate-surface-refreshing')

    // …and the ONE failure mode of that still-live control has to be reachable here
    // too, or "sent to a session that isn't there" is swallowed entirely.
    await waitFor(() => expect(screen.getByTestId('refresh-unreachable-s1')).toBeTruthy())
  })

  it('keeps a minimized surface collapsed across an SSE re-projection', () => {
    const surfaces = [surface('a', 'alpha')]
    const { rerender } = render(<SlatePanel runId="run-1" surfaces={surfaces} />)
    fireEvent.click(screen.getByTestId('minimize-surface-a'))
    expect(screen.queryByText('alpha')).toBeNull()

    rerender(<SlatePanel runId="run-1" surfaces={[...surfaces]} />)
    expect(screen.queryByText('alpha')).toBeNull()
    expect(screen.getByTestId('slate-surface-a').getAttribute('data-minimized')).toBe('true')
  })
})

describe('SlatePanel blank-slate invitation (S6 U5)', () => {
  beforeEach(() => {
    localStorage.clear()
    cleanup()
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => okDelivered(true))
  })

  it('renders the composer INLINE on an open, empty Slate (not the dead hint)', () => {
    render(<SlatePanel runId="run-1" surfaces={[]} open />)

    expect(screen.getByTestId('slate-blank-invite')).toBeTruthy()
    const composer = screen.getByTestId('slate-composer')
    expect(composer.getAttribute('data-inline')).toBe('true')
    // The old one-line hint is gone.
    expect(screen.queryByTestId('slate-empty-hint')).toBeNull()
    // No double-open path: the header "+ Add" is suppressed while the inline
    // composer holds the body.
    expect(screen.queryByTestId('slate-add-surface')).toBeNull()
  })

  it('leaves the inline composer standing through Esc and an outside click', () => {
    // Integration only — the composer here is rendered unconditionally and its
    // onClose is a no-op, so this can't distinguish a working `inline` guard from a
    // deleted one. SlateComposer.test.tsx drives the component directly for that.
    render(<SlatePanel runId="run-1" surfaces={[]} open />)
    expect(screen.getByTestId('slate-composer')).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByTestId('slate-composer')).toBeTruthy()

    fireEvent.pointerDown(document.body)
    expect(screen.getByTestId('slate-composer')).toBeTruthy()
    // Cancel would close to nothing, so it isn't offered inline.
    expect(screen.queryByTestId('composer-cancel')).toBeNull()
  })

  it('withholds the ✕ while the inline composer holds a draft', () => {
    // ✕ collapses the whole column, which would destroy the draft with no way back.
    render(<SlatePanel runId="run-1" surfaces={[]} open onClose={vi.fn()} />)
    expect(screen.getByTestId('slate-close')).toBeTruthy()

    fireEvent.change(screen.getByTestId('composer-freeform'), { target: { value: 'a burndown' } })
    expect(screen.queryByTestId('slate-close')).toBeNull()

    // Clearing the draft gives it back.
    fireEvent.change(screen.getByTestId('composer-freeform'), { target: { value: '' } })
    expect(screen.getByTestId('slate-close')).toBeTruthy()
  })

  it('drops a stale open-composer flag when the Slate empties out', () => {
    // Otherwise the popover would pop back open, unrequested, over the next surface
    // to arrive — including the one authored from the inline composer.
    const { rerender } = render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'hello')]} />)
    fireEvent.click(screen.getByTestId('slate-add-surface'))
    expect(screen.getByTestId('slate-composer').getAttribute('data-inline')).toBeNull()

    rerender(<SlatePanel runId="run-1" surfaces={[]} open />)
    rerender(<SlatePanel runId="run-1" surfaces={[surface('s2', 'later')]} />)

    expect(screen.queryByTestId('slate-composer')).toBeNull()
  })

  it('does not render the inline composer once the Slate has surfaces', () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'hello')]} />)
    expect(screen.queryByTestId('slate-blank-invite')).toBeNull()
    expect(screen.queryByTestId('slate-composer')).toBeNull()

    // …and the header's popover path still works there.
    fireEvent.click(screen.getByTestId('slate-add-surface'))
    const composer = screen.getByTestId('slate-composer')
    expect(composer.getAttribute('data-inline')).toBeNull()
    expect(screen.getByTestId('composer-cancel')).toBeTruthy()
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

  it('carries the slow cyan pulse class only while a surface is refreshing (U4)', () => {
    // The POST never resolves → the surface stays in the refreshing state.
    apiFetch.mockImplementation(() => new Promise<never>(() => {}))
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'x'), surface('s2', 'y')]} />)

    expect(screen.getByTestId('slate-surface-s1').className).not.toContain('slate-surface-refreshing')

    fireEvent.click(screen.getByTestId('refresh-surface-s1'))

    const card = screen.getByTestId('slate-surface-s1')
    expect(card.className).toContain('slate-surface-refreshing')
    expect(card.getAttribute('data-refreshing')).toBe('true')
    // The static glow it replaces must be gone (one cue, not two stacked).
    expect(card.className).not.toContain('shadow-[0_0_14px')
    // The resting border colour stays a UTILITY, so it never depends on a plain CSS
    // rule out-ranking Tailwind by source order.
    expect(card.className).toContain('border-primary/40')
    // A sibling that isn't refreshing keeps the resting hairline.
    expect(screen.getByTestId('slate-surface-s2').className).toContain('border-hairline')
    expect(screen.getByTestId('slate-surface-s2').className).not.toContain('slate-surface-refreshing')
  })

  it('the pulse class the TSX names actually exists in the stylesheet', () => {
    // jsdom never applies src/index.css, so every other assertion here is about a
    // class NAME. Delete the stylesheet block and the whole suite stays green while
    // the cue silently disappears — worse than the static glow it replaced, since
    // the utility that provided that was removed from the TSX.
    // `import.meta.url` is an http:// URL under the jsdom environment, so resolve
    // from the vitest root instead.
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8')
    expect(css).toContain('.slate-surface-refreshing')
    expect(css).toContain('@keyframes slate-refresh-pulse')
    expect(css).toContain('animation: slate-refresh-pulse')
    // …and a reduced-motion user must keep the signal, losing only the motion.
    const reduced = css.slice(css.indexOf('prefers-reduced-motion'))
    expect(reduced).toContain('.slate-surface-refreshing')
    expect(reduced).toContain('animation: none')
    expect(reduced).toContain('box-shadow')
  })

  it('shows the ⚡ fast-path badge only on surfaces carrying a refresh recipe', () => {
    render(
      <SlatePanel
        runId="run-1"
        surfaces={[surface('withrecipe', 'x', { refresh: 're-run the eval' }), surface('norecipe', 'y')]}
      />,
    )
    // Exactly one badge — the recipe-bearing surface.
    expect(screen.getAllByTestId('fast-path-badge')).toHaveLength(1)
    expect(
      screen.getByTestId('slate-surface-withrecipe').querySelector('[data-testid="fast-path-badge"]'),
    ).toBeTruthy()
    expect(
      screen.getByTestId('slate-surface-norecipe').querySelector('[data-testid="fast-path-badge"]'),
    ).toBeNull()
  })
})

// The Objective (S2) is pinned OUT of the grid: above the scroll body, outside the
// search/count/refresh/hide machinery the authored surfaces share.
describe('SlatePanel — the pinned Objective (S2)', () => {
  beforeEach(() => {
    localStorage.clear()
    cleanup()
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => okDelivered(true))
  })

  function objective(headline = 'Ship the objective surface'): SlateSurface {
    return { id: 'objective', author: 'user', kind: 'objective', order: -1, headline, createdAt: 99, amendedAt: 99 }
  }

  it('renders the objective ONCE, above the scroll body, not as a grid card', () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'a surface'), objective()]} />)

    const card = screen.getByTestId('objective-surface')
    expect(card).toBeTruthy()
    expect(screen.getAllByTestId('objective-surface')).toHaveLength(1)
    // Outside the scroll body — it stays put while the surfaces below scroll. Target the
    // GRID by `[data-columns]`, not `[data-scrollable]`: the objective's own prose block
    // also carries `data-scrollable` and renders EARLIER in the tree, so a bare
    // `querySelector('[data-scrollable]')` would return a descendant of `card` and make
    // `.contains(card)` trivially false — passing even if the pin moved into the grid.
    const scrollBody = document.querySelector('[data-columns]')!
    expect(scrollBody.contains(card)).toBe(false)
    expect(scrollBody.hasAttribute('data-scrollable')).toBe(true)
    // …and it never renders through the generic surface shell.
    expect(screen.queryByTestId('slate-surface-objective')).toBeNull()
  })

  it('keeps the objective out of the surface count and the refresh-all fan-out', async () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'a surface'), objective()]} />)

    // The header counter reports the grid, not the pin.
    expect(screen.getByText('1')).toBeTruthy()

    fireEvent.click(screen.getByTestId('slate-refresh-all'))
    await waitFor(() => expect(apiFetch).toHaveBeenCalled())
    const refreshed = apiFetch.mock.calls.map((c) => c[0] as string)
    expect(refreshed.some((p) => p.includes('/slate/surfaces/objective/refresh'))).toBe(false)
  })

  it('holds the column open on its own (an objective is enough to render)', () => {
    render(<SlatePanel runId="run-1" surfaces={[objective()]} />)
    expect(screen.getByTestId('objective-surface')).toBeTruthy()
    // No Close: the panel would immediately re-render itself while run.slate is
    // non-empty, so offering one would lie.
    expect(screen.queryByTestId('slate-close')).toBeNull()
  })

  it('offers the "set an objective" affordance when the run has none', () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'a surface')]} />)
    expect(screen.getByTestId('objective-set')).toBeTruthy()
    expect(screen.queryByTestId('objective-surface')).toBeNull()
  })

  it('is not filtered away by the search (it is the goal, not a hit)', () => {
    render(<SlatePanel runId="run-1" surfaces={[surface('s1', 'a surface'), objective()]} />)
    fireEvent.click(screen.getByTestId('slate-search-open'))
    fireEvent.change(screen.getByTestId('slate-search'), { target: { value: 'zzz-no-match' } })

    expect(screen.getByTestId('slate-no-matches')).toBeTruthy()
    expect(screen.getByTestId('objective-surface')).toBeTruthy()
  })

  it('still renders nothing at all when there is neither a surface nor an objective', () => {
    const { container } = render(<SlatePanel runId="run-1" surfaces={[]} />)
    expect(container.firstChild).toBeNull()
  })
})

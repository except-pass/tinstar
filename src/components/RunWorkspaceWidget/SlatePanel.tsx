// The Slate — a run-scoped column of small A2UI surfaces (plan U5/U6/U8, R1–R3,
// R13, R16, R17; Slate v2 U1/U2, R2/R4).
//
// The panel dispatches on each surface's `kind`:
//   · 'objective'  → the run's goal (S2), lifted out of the grid and PINNED between
//     the header and the scroll body. User-owned prose, so it sits outside the
//     search/count/refresh/hide machinery the authored surfaces share.
//   · 'open-point' → the open-points hero surface (U6): all open-points share ONE
//     grouped list with status pills, a state track, threads, soft resolve, and an
//     add-a-point input. Rendered once, at the position of the first open-point.
//   · 'diagram'    → the diagram hero surface (U8): the A2UI picture plus a
//     per-surface thread anchored to the surface id.
//   · anything else → the generic U5 render: the file-owned A2UI `body` through the
//     SHARED `A2uiRenderer` (never a re-implemented walker), wrapped per-surface in
//     its own `A2uiErrorBoundary` so one malformed/hostile surface degrades ALONE.
//
// Slate v2:
//   · U1/R2 — the scroll body is a CSS grid that reflows 1→2 columns as the column
//     is drag-resized (see `RunWorkspaceWidget`); the open-points list always spans
//     the full width, diagram/generic surfaces flow into the grid.
//   · U2/R4 — each surface carries a ✕ hide affordance; hiding is a per-browser view
//     preference (uiPrefs `hiddenSlateSurfaces`, mirror of `hiddenRuns`), so it's
//     non-destructive and a file re-projection can't resurrect it (the filter reads
//     the persisted set on every render). A header toggle reveals hidden surfaces
//     (dimmed, each with an "unhide") with a count.
//
// This panel is purely additive: it renders NOTHING when the run has no Slate
// surfaces, so the run card keeps its existing three-panel layout unchanged.
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { SlateSurface } from '../../types'
import { A2uiRenderer, A2uiErrorBoundary } from '../../a2ui/A2uiRenderer'
import { OpenPointsSurface, orderOpenPoints } from './OpenPointsSurface'
import { partitionWorkbenches } from './WorkbenchSurface'
import { DiagramSurface } from './DiagramSurface'
import { ObjectiveSurface } from './ObjectiveSurface'
import {
  getHiddenSlateSurfaces, addHiddenSlateSurface, removeHiddenSlateSurface,
  getMinimizedSlateSurfaces, addMinimizedSlateSurface, removeMinimizedSlateSurface,
} from '../../lib/uiPrefs'
import { useSlateRefresh, RefreshButton } from './slateRefresh'
import { SlateComposer } from './SlateComposer'
import { SlateExplainButton } from './SlateExplainButton'
import { SlateCleanButton } from './SlateCleanButton'
import { SurfaceAge } from './SurfaceAge'
import { FastPathBadge } from './FastPathBadge'
import { useNow } from '../../hooks/useNow'
import { SLATE_HOTKEYS, keyToSlateAction } from './slateHotkeys'
import { surfaceHaystack } from './slateSearch'
import { isEditable } from '../../hotkeys/isEditable'

/** Column width (px) at/above which surfaces reflow into two columns (R2). Kept
 *  in step with the resize clamp in `RunWorkspaceWidget` (min 260, max 560). */
const SLATE_TWO_COL_MIN = 420

interface Props {
  /** The run id (= the run's `.id`) — Slate mutations are run-scoped. */
  runId: string
  /** The run's Slate projection. Undefined/empty renders nothing (additive) unless
   *  `open` forces a blank Slate to render. */
  surfaces?: SlateSurface[]
  /** Measured column width (px) driving the 1→2 column reflow (R2). When absent
   *  the grid stays single-column. */
  width?: number
  /** When true, render even with zero surfaces (a blank Slate the user opened on
   *  purpose) so Explain / + Add are reachable to fill it. */
  open?: boolean
  /** Collapse the (blank) Slate back to the strip. Only offered when there are no
   *  surfaces holding the column open. */
  onClose?: () => void
  /** S6 U1 — the Slate zone currently holds the widget's focus. Arms the `?`
   *  capture shim (and nothing else: the other six keys are gated upstream, in the
   *  widget's action handler). */
  focused?: boolean
}

/** The keyboard surface RunWorkspaceWidget drives (S6 U1). The widget owns the
 *  binding registration and the focus-zone gate; the panel owns what each action
 *  actually means. */
export interface SlatePanelHandle {
  focusNext: () => void
  focusPrev: () => void
  hideFocused: () => void
  refreshFocused: () => void
  openComposer: () => void
  focusSearch: () => void
  toggleCheatsheet: () => void
}

/** Sort by `order` (undefined sinks to the end) then `createdAt` tiebreak. */
function sortSurfaces(surfaces: SlateSurface[]): SlateSurface[] {
  return [...surfaces].sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY
    const bo = b.order ?? Number.POSITIVE_INFINITY
    if (ao !== bo) return ao - bo
    return a.createdAt - b.createdAt
  })
}

/** A ✕ hide / "unhide" control shared by the diagram and generic surface cards.
 *  Inline (unpositioned) — it lives in the card's absolute control cluster next to
 *  the refresh button (see the card wrapper). */
function HideToggle({ id, hidden, onHide, onUnhide }: {
  id: string
  hidden: boolean
  onHide: (id: string) => void
  onUnhide: (id: string) => void
}) {
  if (hidden) {
    return (
      <button
        data-testid={`unhide-surface-${id}`}
        onClick={() => onUnhide(id)}
        title="Unhide this surface"
        className="rounded bg-surface-hover px-1 text-[9px] text-ink-low hover:text-ink-high"
      >
        unhide
      </button>
    )
  }
  return (
    <button
      data-testid={`hide-surface-${id}`}
      onClick={() => onHide(id)}
      title="Hide this surface (view-only — the file stays intact)"
      className="rounded px-1 text-[11px] leading-none text-ink-ctrl hover:text-ink-high"
    >
      ✕
    </button>
  )
}

/** A – minimize / + restore control (S6 U3). Distinct from ✕ hide: minimize keeps
 *  the card in its slot, collapsed to its title; hide removes it from the view.
 *  Both are per-browser view preferences, neither touches the agent's file. */
function MinimizeToggle({ id, minimized, onMinimize, onRestore }: {
  id: string
  minimized: boolean
  onMinimize: (id: string) => void
  onRestore: (id: string) => void
}) {
  return (
    <button
      data-testid={minimized ? `restore-surface-${id}` : `minimize-surface-${id}`}
      onClick={() => (minimized ? onRestore(id) : onMinimize(id))}
      title={minimized ? 'Restore this surface' : 'Minimize to just the title (the surface stays on the Slate)'}
      className="rounded px-1 text-[11px] leading-none text-ink-ctrl hover:text-ink-high"
    >
      {minimized ? '+' : '–'}
    </button>
  )
}

/** The `?` overlay (S6 U1). Mono keycaps and labels, hairline border, control ink —
 *  no cyan: a reference card is the opposite of a live edge. */
function SlateCheatsheet({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      data-testid="slate-cheatsheet"
      onClick={onDismiss}
      className="absolute inset-0 z-30 flex items-start justify-center bg-surface-base/80 p-3"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[260px] rounded border border-hairline bg-surface-raised p-3 shadow-lg"
      >
        <div className="mb-2 font-mono text-2xs uppercase tracking-[0.12em] text-ink-low">
          Slate keys
        </div>
        <dl className="flex flex-col gap-1">
          {SLATE_HOTKEYS.map((h) => (
            <div key={h.key} className="flex items-baseline gap-2">
              <dt className="w-5 shrink-0 rounded-sm bg-surface-hover text-center font-mono text-[11px] text-ink-mid">
                {h.key}
              </dt>
              <dd className="font-mono text-[11px] text-ink-ctrl">{h.label}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-2 font-mono text-[10px] text-ink-ctrl">esc / ? to close</div>
      </div>
    </div>
  )
}

export const SlatePanel = forwardRef<SlatePanelHandle, Props>(function SlatePanel(
  { runId, surfaces = [], width, open = false, onClose, focused = false }: Props,
  ref,
) {
  // Hidden surfaces are a per-browser view preference; seed from the persisted
  // set and keep a React copy so mutations re-render. The filter is applied on
  // every render against this set, so an SSE re-projection never resurrects a
  // hidden surface (R4).
  const [hidden, setHidden] = useState<Set<string>>(() => getHiddenSlateSurfaces())
  // Minimized surfaces (S6 U3) — the same per-browser view-preference contract as
  // `hidden`, for a different state: collapsed to its title but still on the Slate.
  // Keyed by (runId, surfaceId) in storage — a surface id is only unique WITHIN a
  // run, so an un-scoped set would collapse `decisions` on every run the moment it
  // was minimized on one. The in-memory copy holds bare ids for this run.
  const [minimized, setMinimized] = useState<Set<string>>(() => getMinimizedSlateSurfaces(runId))
  const [showHidden, setShowHidden] = useState(false)
  const [composerOpen, setComposerOpen] = useState(false)
  // The inline composer holds a draft the ✕ would silently destroy (S6 U5).
  const [composerDirty, setComposerDirty] = useState(false)

  // A panel instance is normally pinned to one run, but re-seed if it is ever reused
  // for another — otherwise it would show run A's minimized set on run B. Guarded by
  // the seeded id so the mount pass doesn't burn a second render on an identical set.
  const seededRunId = useRef(runId)
  useEffect(() => {
    if (seededRunId.current === runId) return
    seededRunId.current = runId
    setMinimized(getMinimizedSlateSurfaces(runId))
  }, [runId])

  // The Objective (S2) is lifted OUT of the grid and pinned above it: it is the run's
  // goal, so it stays on screen while the surfaces below scroll, and it is excluded
  // from the search filter, the surface count, refresh-all, hide/minimize, and the
  // j/k focus ring — it's the user's own prose, not an authored, refreshable surface.
  const objective = useMemo(() => surfaces.find((s) => s.kind === 'objective'), [surfaces])
  const gridSurfaces = useMemo(() => surfaces.filter((s) => s.kind !== 'objective'), [surfaces])

  // Sorted once, above the early return, so the refresh hook (which must run
  // unconditionally) can watch the same list the render uses.
  const sorted = useMemo(() => sortSurfaces(gridSurfaces), [gridSurfaces])
  const { refreshingIds, unreachableIds, bulkRefreshing, refresh, refreshAll } = useSlateRefresh(runId, sorted)
  // One ticking clock for the whole panel — every surface's "updated Xm ago" reads
  // from this so they agree and there's no timer-per-card.
  const now = useNow()

  const hide = useCallback((id: string) => {
    addHiddenSlateSurface(id)
    setHidden((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  const unhide = useCallback((id: string) => {
    removeHiddenSlateSurface(id)
    setHidden((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const minimize = useCallback((id: string) => {
    addMinimizedSlateSurface(runId, id)
    setMinimized((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [runId])

  const restore = useCallback((id: string) => {
    removeMinimizedSlateSurface(runId, id)
    setMinimized((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [runId])

  /** Drop the per-browser VIEW state (hidden / minimized ids) for the surfaces a
   *  clean just destroyed. Both are keyed by surface id in uiPrefs and survive a
   *  re-projection by design — which is right for hide (a file rewrite must not
   *  resurrect what you dismissed) but wrong after a clean: the ids now name
   *  surfaces that no longer exist, so the header would keep offering a
   *  "2 hidden · show" toggle that reveals nothing. Clears only ids the panel is
   *  currently showing, so another run's prefs are untouched. */
  const forgetSurfaceViewState = useCallback(() => {
    for (const surface of gridSurfaces) {
      removeHiddenSlateSurface(surface.id)
      removeMinimizedSlateSurface(runId, surface.id)
    }
    setHidden(new Set())
    setMinimized(new Set())
  }, [gridSurfaces, runId])

  // ── Keyboard surface (S6 U1) ────────────────────────────────────────────
  // Search (`/`), the cheatsheet (`?`), and the focused row (j/k). "Focus" here is
  // client-only and orthogonal to the widget's `focusZone`: it's which ROW inside
  // the Slate the next x/r applies to.
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false)
  const [focusedSurfaceId, setFocusedSurfaceId] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const q = query.trim().toLowerCase()
  /** The surfaces the body renders — everything, or the search hits.
   *
   *  The haystack per surface includes its RENDERED body text, not just
   *  headline/id/kind — an expanded card never shows its `headline`, so a haystack of
   *  invisible fields would report "no match" about a surface the user is looking
   *  straight at (see slateSearch.ts). Built inside this memo rather than alongside
   *  `sorted`, so the walk costs nothing on the overwhelmingly common no-filter path
   *  (it would otherwise re-run on every SSE run delta). */
  const matched = useMemo(() => {
    if (!q) return sorted
    return sorted.filter((s) => surfaceHaystack(s).includes(q))
  }, [sorted, q])

  const openPoints = useMemo(() => matched.filter((s) => s.kind === 'open-point'), [matched])

  /**
   * The rows j/k walks, in the order they appear on screen: each visible open point
   * (the grouped list's rows are traversable individually — that's where x and r are
   * most useful) followed by each visible card, interleaved exactly as rendered.
   * `orderOpenPoints` is imported from OpenPointsSurface rather than re-derived, so
   * this can't drift out of step with what that component actually renders.
   *
   * S4: a point swallowed by a workbench is NOT a row, so `partitionWorkbenches`
   * drops it here too. Traversing into a column would put the focus ring — and the
   * x/r that follow it — on something that isn't on screen as a row. `hidden` is
   * passed as the exclusion set for the SAME reason OpenPointsSurface passes it: a
   * hidden point never joins a band, so it stays a row here and stays reachable.
   */
  const focusRows = useMemo(() => {
    const rows: SlateSurface[] = []
    const firstIdx = matched.findIndex((s) => s.kind === 'open-point')
    matched.forEach((s, i) => {
      if (s.kind === 'open-point') {
        if (i !== firstIdx) return
        rows.push(
          ...partitionWorkbenches(orderOpenPoints(openPoints, hidden, showHidden), hidden).ungrouped,
        )
        return
      }
      if (hidden.has(s.id) && !showHidden) return
      rows.push(s)
    })
    return rows
  }, [matched, openPoints, hidden, showHidden])

  // Clamp, don't wrap: running off the end of a list and silently reappearing at the
  // top is disorienting when you can't see the whole column. The FIRST press lands on
  // the first row rather than moving from nowhere.
  const moveFocus = useCallback((delta: 1 | -1) => {
    setFocusedSurfaceId((prev) => {
      if (focusRows.length === 0) return null
      const i = prev ? focusRows.findIndex((s) => s.id === prev) : -1
      if (i < 0) return focusRows[0]!.id
      const next = Math.min(Math.max(i + delta, 0), focusRows.length - 1)
      return focusRows[next]!.id
    })
  }, [focusRows])

  const hideFocused = useCallback(() => {
    const i = focusRows.findIndex((s) => s.id === focusedSurfaceId)
    if (i < 0) return
    hide(focusRows[i]!.id)
    // Keep the keyboard somewhere useful: fall to the next row, or back to the
    // previous one when the hidden row was last.
    const next = focusRows[i + 1] ?? focusRows[i - 1] ?? null
    setFocusedSurfaceId(next ? next.id : null)
  }, [focusRows, focusedSurfaceId, hide])

  const refreshFocused = useCallback(() => {
    const s = focusRows.find((x) => x.id === focusedSurfaceId)
    if (s) refresh(s)
  }, [focusRows, focusedSurfaceId, refresh])

  const openComposer = useCallback(() => {
    // On a blank Slate the composer is already on screen (U5) — put the cursor in it
    // instead of stacking a popover on top of it.
    if (sorted.length === 0) {
      const el = rootRef.current?.querySelector<HTMLInputElement>('[data-testid="composer-search"]')
      el?.focus()
      return
    }
    setComposerOpen(true)
  }, [sorted.length])

  const focusSearch = useCallback(() => {
    setSearchOpen(true)
    // The input may not exist yet on the frame the key fires.
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [])

  const toggleCheatsheet = useCallback(() => setCheatsheetOpen((v) => !v), [])

  useImperativeHandle(ref, () => ({
    focusNext: () => moveFocus(1),
    focusPrev: () => moveFocus(-1),
    hideFocused,
    refreshFocused,
    openComposer,
    focusSearch,
    toggleCheatsheet,
  }), [moveFocus, hideFocused, refreshFocused, openComposer, focusSearch, toggleCheatsheet])

  // Keep the focused row on screen. The body is a scroll container, so without this
  // `j` past the last visible card moves the ring off-screen and the panel looks
  // dead — and `x` would then hide a surface the user can't see.
  useEffect(() => {
    if (!focusedSurfaceId) return
    const el = rootRef.current?.querySelector('[data-focused="true"]')
    // jsdom has no layout, so scrollIntoView is not always defined there.
    if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
      (el as HTMLElement).scrollIntoView({ block: 'nearest' })
    }
  }, [focusedSurfaceId])

  // The cheatsheet belongs to the focused Slate. Leaving it up after focus moves
  // away would strand an overlay whose `?` toggle has unmounted — and whose Esc
  // handler (below) would go on swallowing Escape for the whole app.
  useEffect(() => {
    if (!focused) setCheatsheetOpen(false)
  }, [focused])

  // The composer popover is the non-empty path only; if the last surface goes away
  // while it's open, clear the flag so it can't pop back up unrequested when the
  // next surface arrives.
  useEffect(() => {
    if (sorted.length === 0) setComposerOpen(false)
  }, [sorted.length])

  // The `?` shim — the ONE key that can't ride the binding registry. `useGlobalHotkeys`
  // claims `?` for the command palette on a bubble-phase window listener guarded only
  // by `isEditable`; it has no idea about focus zones. So we listen in the CAPTURE
  // phase (which runs first) and `stopImmediatePropagation` so the palette never sees
  // the event. Armed only while the Slate zone holds focus, so `?` still opens the
  // palette everywhere else.
  useEffect(() => {
    if (!focused) return
    function onKey(e: KeyboardEvent) {
      if (isEditable(document.activeElement)) return
      if (keyToSlateAction(e) !== 'cheatsheet') return
      e.preventDefault()
      e.stopImmediatePropagation()
      setCheatsheetOpen((v) => !v)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [focused])

  // Esc dismisses the cheatsheet (capture, to beat anything focused underneath).
  // Narrow on purpose: it only claims Escape while the overlay is up AND the Slate
  // holds focus, and never while the caret is in a field — an Escape a text input
  // owns (clearing the search, closing a popover) must still reach it.
  useEffect(() => {
    if (!cheatsheetOpen || !focused) return
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (isEditable(document.activeElement)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      setCheatsheetOpen(false)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [cheatsheetOpen, focused])

  // Additive: no surfaces → render nothing (card layout unchanged) UNLESS the user
  // opened the Slate blank on purpose (`open`), in which case we render the header so
  // Explain / + Add are reachable to fill it.
  if (surfaces.length === 0 && !open) return null

  // The grouped open-points list renders once, at the first open-point's slot.
  const firstOpenPointIdx = matched.findIndex((s) => s.kind === 'open-point')

  const hiddenCount = sorted.filter((s) => hidden.has(s.id)).length
  const columns = width && width >= SLATE_TWO_COL_MIN ? 2 : 1
  // "Refresh all" fans out over every VISIBLE surface (each open point is a surface
  // too) — a recipe is optional, so all of them are refreshable.
  const visibleSurfaces = matched.filter((s) => showHidden || !hidden.has(s.id))

  return (
    <div ref={rootRef} className="relative flex flex-col h-full min-w-0">
      {/* Header strip — the only always-visible chrome (design: Panel chrome). Mono
          label left, quiet actions right. Cyan is spent on ONLY the two generative
          moves (✦ Explain, + Add) — the live/creative edge (P4); everything else
          (maintenance, counts, close) stays low-contrast ink. */}
      <div className="px-3 py-1.5 border-b border-hairline bg-surface-panel/60 flex items-center justify-between gap-2">
        <span className="text-[11px] font-mono text-ink-low uppercase tracking-[0.12em]">The Slate</span>
        <div className="flex items-center gap-2">
          {/* Search (S6 U1, `/`). Collapsed to a glyph until asked for, so the
              header doesn't grow a permanent field on a three-surface Slate.
              Maintenance, not generative — control ink, never cyan. */}
          {searchOpen ? (
            <input
              ref={searchRef}
              data-testid="slate-search"
              value={query}
              placeholder="Filter…"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                e.preventDefault()
                setQuery('')
                setSearchOpen(false)
              }}
              className="w-20 rounded border border-hairline bg-surface-panel px-1 py-0.5 font-mono text-2xs text-ink-high placeholder:text-ink-ctrl focus:border-primary/60 focus:outline-none"
            />
          ) : (
            <button
              data-testid="slate-search-open"
              onClick={focusSearch}
              title="Filter surfaces ( / )"
              className="text-2xs leading-none text-ink-ctrl hover:text-ink-high"
            >
              ⌕
            </button>
          )}
          {hiddenCount > 0 && (
            <button
              data-testid="slate-hidden-toggle"
              onClick={() => setShowHidden((v) => !v)}
              className="text-2xs font-mono text-ink-low hover:text-ink-mid"
            >
              {hiddenCount} hidden · {showHidden ? 'hide' : 'show'}
            </button>
          )}
          {/* Slate-level loading state while a refresh-all is still settling. */}
          {bulkRefreshing && (
            <span data-testid="slate-refreshing-all" className="text-2xs font-mono text-ink-low animate-pulse">
              refreshing…
            </span>
          )}
          {/* Refresh ALL visible surfaces (each open point counts). Maintenance, not
              generative — quiet control ink, never cyan. */}
          <button
            data-testid="slate-refresh-all"
            onClick={() => refreshAll(visibleSurfaces)}
            disabled={bulkRefreshing}
            // While a filter is on, this fans out over the MATCHES only — say so,
            // rather than promising "every surface" and quietly skipping the rest.
            title={q
              ? `Refresh the ${visibleSurfaces.length} matching surface${visibleSurfaces.length === 1 ? '' : 's'} — re-run each one’s author`
              : 'Refresh every surface — re-run each one’s author'}
            className="text-ink-ctrl hover:text-ink-high disabled:opacity-70 leading-none"
          >
            <span className={bulkRefreshing ? 'inline-block animate-spin' : 'inline-block'}>⟳</span>
          </button>
          {/* Wipe the whole Slate (files + points, Objective survives). Destructive,
              so it confirms first — and it takes EVERY surface, not the filtered
              subset refresh-all fans out over. */}
          <SlateCleanButton
            runId={runId}
            surfaceCount={sorted.length}
            hasObjective={objective !== undefined}
            onCleaned={forgetSurfaceViewState}
          />
          {/* One-click: ask the agent to (re-)explain the session as surfaces. A
              generative move — carries the cyan. */}
          <SlateExplainButton runId={runId} />
          {/* Open the composer to author a new surface. The other generative move —
              cyan, like Explain. Suppressed on a BLANK Slate: there the composer is
              already rendered inline in the body (S6 U5), and two composers on one
              panel is the "double-open" this avoids. */}
          {sorted.length > 0 && (
            <button
              data-testid="slate-add-surface"
              // Open-only: the composer closes itself (outside-click / cancel / escape).
              // A toggle here fights its outside-pointerdown handler — that fires first and
              // closes it, then the toggle flips it back open, so it could never close.
              onClick={() => setComposerOpen(true)}
              title="Add a surface"
              className="text-2xs font-mono text-primary hover:text-primary/80"
            >
              + Add surface
            </button>
          )}
          <span className="text-2xs font-mono text-ink-low">{sorted.length}</span>
          {/* Close only when nothing holds the column open (a blank, user-opened
              Slate) AND the inline composer isn't holding a draft — collapsing the
              column would destroy typed text with no way back to it. The ✕ returns
              as soon as the draft is cleared or sent. An objective counts as holding
              the column open — the panel re-renders itself while `run.slate` is
              non-empty, so offering a Close that can't close would lie. */}
          {surfaces.length === 0 && !composerDirty && onClose && (
            <button
              data-testid="slate-close"
              onClick={onClose}
              title="Close the Slate"
              className="text-2xs text-ink-ctrl hover:text-ink-high leading-none"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* The `?` cheatsheet (S6 U1) — an overlay over the column, dismissed by ?, Esc,
          or a click outside the card. */}
      {cheatsheetOpen && <SlateCheatsheet onDismiss={() => setCheatsheetOpen(false)} />}

      {/* The Objective (S2) — pinned between the header and the scroll body, so the
          run's goal never scrolls away under the surfaces it governs. Rendered even
          when the run has none: there it collapses to a single quiet "+ Set an
          objective" line, which is the only way to author the first one. */}
      <div className="shrink-0 px-2 pt-2">
        <ObjectiveSurface runId={runId} surface={objective} />
      </div>

      {/* The composer popover — anchored under the header (R7/U4). Only ever the
          non-empty path; a blank Slate carries the inline composer instead. */}
      {composerOpen && sorted.length > 0 && (
        <div className="absolute top-8 right-2 z-20 w-64 max-w-[calc(100%-1rem)]">
          <SlateComposer runId={runId} onClose={() => setComposerOpen(false)} />
        </div>
      )}

      {/* Scroll body — data-scrollable so the canvas wheel handler yields the
          wheel to this column instead of panning the canvas (useCanvasCamera).
          A CSS grid reflows 1→2 columns with the measured width (R2); the #126
          layout guards (overflow-x-hidden, overflow-wrap, per-cell min-w-0) still
          hold so `columnsOverlapPx === 0` / no horizontal overflow survive. */}
      <div
        data-scrollable
        data-columns={columns}
        className={`flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin p-2 grid gap-2 items-start [overflow-wrap:anywhere] ${columns === 2 ? 'grid-cols-2' : 'grid-cols-1'}`}
      >
        {/* An open-but-empty Slate is an INVITATION, not a dead end (S6 U5): the
            composer renders inline, right where the surfaces would be, so the first
            move is already on screen. `inline` suppresses its popover self-close
            (Esc / outside-click) and its Cancel — there is nothing to close back to.
            The header's "+ Add surface" popover is still the path once surfaces
            exist, so the two never both show. */}
        {sorted.length === 0 && (
          <div data-testid="slate-blank-invite" className="col-span-full flex flex-col gap-2 px-1 pt-4">
            <div className="text-center font-sans text-[12px] leading-relaxed text-ink-low">
              {/* "else" once an objective is pinned above — otherwise the invitation
                  would contradict the card the user is looking at. */}
              Nothing {objective ? 'else ' : ''}on the Slate yet — describe a surface, or{' '}
              <span className="text-ink-mid">✦ Explain</span> the session.
            </div>
            <SlateComposer runId={runId} inline onClose={() => {}} onDraftChange={setComposerDirty} />
          </div>
        )}
        {/* A search that matches nothing says so, rather than looking like an empty
            Slate — the surfaces are still there, just filtered out. */}
        {sorted.length > 0 && matched.length === 0 && (
          <div data-testid="slate-no-matches" className="col-span-full px-1 py-6 text-center font-mono text-2xs text-ink-ctrl">
            No surface matches “{query.trim()}”.
          </div>
        )}
        {matched.map((surface, i) => {
          // Open-points collapse into one grouped list at the first one's slot;
          // it always spans the full width (R2). Per-point hiding lives inside.
          if (surface.kind === 'open-point') {
            if (i !== firstOpenPointIdx) return null
            return (
              <div key="open-points" className="col-span-full min-w-0">
                <OpenPointsSurface
                  runId={runId}
                  points={openPoints}
                  hiddenIds={hidden}
                  showHidden={showHidden}
                  onHide={hide}
                  onUnhide={unhide}
                  refreshingIds={refreshingIds}
                  unreachableIds={unreachableIds}
                  onRefresh={refresh}
                  now={now}
                  focusedId={focusedSurfaceId}
                />
              </div>
            )
          }

          const isHidden = hidden.has(surface.id)
          // Hidden + not revealing → skip entirely; revealing → render dimmed.
          if (isHidden && !showHidden) return null

          const isRefreshing = refreshingIds.has(surface.id)
          const isUnreachable = unreachableIds.has(surface.id)
          // Minimize is orthogonal to hide (S6 U3); a hidden surface isn't rendered
          // at all (or is rendered dimmed under "show hidden"), so hide wins.
          const isMinimized = minimized.has(surface.id) && !isHidden
          // The card's control cluster: refresh (⟳), minimize (–/+), hide (✕), top-right.
          const controls = (
            <div className="absolute top-1 right-1 z-10 flex items-center gap-1">
              {!isHidden && (
                <RefreshButton id={surface.id} refreshing={isRefreshing} onClick={() => refresh(surface)} />
              )}
              {!isHidden && (
                <MinimizeToggle
                  id={surface.id}
                  minimized={isMinimized}
                  onMinimize={minimize}
                  onRestore={restore}
                />
              )}
              <HideToggle id={surface.id} hidden={isHidden} onHide={hide} onUnhide={unhide} />
            </div>
          )
          // Shown when a refresh reached nobody (delivered:false / unreachable run).
          // Framed as a quiet note, not an error (low ink) — the run being asleep isn't
          // a failure of the surface.
          const note = isUnreachable ? (
            <div data-testid={`refresh-unreachable-${surface.id}`} className="mt-2 font-sans text-[11px] leading-snug text-ink-low">
              Sent — but that session isn’t reachable right now.
            </div>
          ) : null
          // Freshness footer: "updated Xm ago", ambering when the surface hasn't been
          // tended in a while — the visible cue so a stale assertion gets a second look.
          // A ⚡ leads it when the surface self-refreshes from a recipe (fast path).
          const footer = (
            <div className="mt-1 flex items-center justify-end gap-1.5">
              {surface.refresh && <FastPathBadge className="text-[10px]" />}
              <SurfaceAge amendedAt={surface.amendedAt} now={now} />
            </div>
          )

          // One shell for every non-list surface kind (P2, "one system, N surfaces"):
          // raised card, hairline border, 14px padding. State signals live at the
          // EDGES — a slow cyan pulse marks an in-flight refresh (P4, the live edge;
          // `.slate-surface-refreshing` + its keyframes live in src/index.css, since
          // tailwind.config keyframes are not bundled into that stylesheet), dimming
          // marks hidden — so the authored body never moves between states.
          // The j/k focus ring is cyan: keyboard focus is a live, moving thing (P4),
          // and it never collides with the refresh pulse — that lives on the border
          // and the shadow, this on the ring.
          const isFocused = focusedSurfaceId === surface.id
          const shellClass = [
            'relative rounded border min-w-0 transition-shadow',
            isMinimized ? 'px-[14px] py-2' : 'p-[14px]',
            isRefreshing ? 'border-primary/40 bg-surface-raised slate-surface-refreshing' : 'border-hairline bg-surface-raised',
            isFocused ? 'ring-1 ring-primary/70' : '',
            isHidden ? 'opacity-50' : '',
          ].join(' ')

          // Minimized (S6 U3): the card keeps its slot and its edges — only the body
          // goes. The title row (the meta-label type ramp: mono 11 caps, deliberately
          // NOT the surface headline ramp — a collapsed card is a label, not a
          // heading) plus the freshness stamp stay, so a collapsed surface still says
          // what it is and how fresh it is, and the + in the control cluster brings it
          // back. A minimized surface that's refreshing still pulses, since the pulse
          // lives on the shell.
          if (isMinimized) {
            return (
              <div
                key={surface.id}
                data-testid={`slate-surface-${surface.id}`}
                data-minimized="true"
                data-refreshing={isRefreshing ? 'true' : undefined}
                data-focused={isFocused ? 'true' : undefined}
                className={shellClass}
              >
                {controls}
                <div className="flex items-center gap-2 pr-16 min-w-0">
                  {/* The ⟳ stays live while collapsed, so its ONE failure mode has to
                      be reachable here too — otherwise "sent to a session that isn't
                      there" is swallowed entirely. Same testid as the expanded note,
                      compacted to a marker with the message on hover. */}
                  {isUnreachable && (
                    <span
                      data-testid={`refresh-unreachable-${surface.id}`}
                      title="Sent — but that session isn’t reachable right now."
                      className="shrink-0 text-[10px] leading-none text-ink-low"
                    >
                      ⚠
                    </span>
                  )}
                  <span
                    data-testid={`slate-minimized-title-${surface.id}`}
                    className="truncate font-mono text-[11px] uppercase tracking-[0.12em] text-ink-mid"
                  >
                    {surface.headline ?? surface.id}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {surface.refresh && <FastPathBadge className="text-[10px]" />}
                    <SurfaceAge amendedAt={surface.amendedAt} now={now} />
                  </span>
                </div>
              </div>
            )
          }

          return (
            <div
              key={surface.id}
              data-testid={`slate-surface-${surface.id}`}
              data-refreshing={isRefreshing ? 'true' : undefined}
              data-focused={isFocused ? 'true' : undefined}
              className={shellClass}
            >
              {controls}
              {surface.kind === 'diagram' ? (
                <DiagramSurface runId={runId} surface={surface} />
              ) : (
                /* Per-surface boundary: a throw or malformed body degrades THIS
                   surface alone; siblings are untouched (R2, per-surface budget). */
                <A2uiErrorBoundary source={surface.body}>
                  <A2uiRenderer content={surface.body} />
                </A2uiErrorBoundary>
              )}
              {note}
              {footer}
            </div>
          )
        })}
      </div>
    </div>
  )
})

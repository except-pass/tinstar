// A2UI `Mermaid` catalog component (Slate S1): turns an agent-supplied Mermaid
// definition string into a laid-out, host-themed SVG. Client-only — mermaid is
// dynamically imported so it stays in its own lazy chunk and never reaches the
// React-free server bundle (schema.ts / controls.ts / followUps.ts). The catalog
// (catalog.tsx) is the only importer, and the catalog is imported only by the
// client A2uiRenderer.
//
// Pattern ported from the file-editor's MermaidBlock
// (src/plugins/file-editor/src/MarkdownRenderer.tsx): the SVG is held in state
// (a ref deadlocks — the target div is unmounted while loading, so a ref would
// be null the moment render() resolves), the effect is keyed on its inputs with
// a `cancelled` flag, and mermaid is imported inside the effect.
//
// Three deliberate divergences from that precedent:
//   1. THEME (P4): the Slate design language reserves cyan (#00f0ff) for the
//      live edge only — "Static surfaces stay neutral so liveness stands out."
//      NEITHER theme here may use it. The default `ink` treatment is neutral
//      monochrome; `hue` opts into the semantic hue.* palette (see MERMAID_THEMES).
//   2. SECURITY: content is agent-authored and reaches us through a passthrough
//      schema, so `source` is untrusted. `securityLevel: 'strict'` is pinned
//      explicitly (encodes HTML in labels, disables click/JS directives, routes
//      output through mermaid's DOMPurify) rather than left to the default.
//   3. SIZING: the Slate column is only 260–560px wide and its scroll body is
//      `overflow-x-hidden` (the #126 horizontal-overflow guard), so a diagram may
//      NOT introduce a horizontal scrollbar or overflow at natural size. Inline it
//      is scaled to fit the column; clicking opens a portaled expanded view at
//      readable size.
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

// Module-scoped monotonic id so each rendered diagram gets a unique DOM id
// (mermaid.render needs a unique id per call). Kept out of component state so a
// re-render doesn't churn it.
let mermaidIdCounter = 0

/** The diagram treatments an author can pick between, per diagram. */
export type MermaidTheme = 'ink' | 'hue'

/** Coerce an authored `theme` prop to a known treatment. Content is
 *  agent-authored through a passthrough schema, so anything at all can arrive
 *  here — an unknown string, a number, a binding object, or nothing. Everything
 *  that isn't exactly 'hue' falls back to the on-language 'ink' default; this
 *  never throws. */
export function normalizeTheme(value: unknown): MermaidTheme {
  return value === 'hue' ? 'hue' : 'ink'
}

// Both treatments keep dark node fills and ink.high labels so text stays legible
// on the dark card; they differ only in the accent colors used for node borders
// and edges. NEITHER may contain the reserved live-edge cyan (#00f0ff / #00a5b0)
// — a test asserts this over every value of both themes.
//
// TODO(light-theme): when a light Slate palette exists, read a theme signal here
// and swap the surface/ink values — a future light mode is then a one-function
// change. Dark-only today (no prefers-color-scheme / data-theme in these widgets).
const MERMAID_THEMES: Record<MermaidTheme, Record<string, string>> = {
  // Default. Neutral monochrome — the on-language treatment (P4: static surfaces
  // stay neutral so the live edge stands out).
  ink: {
    primaryColor: '#141c24', //       surface.hover — one lightness step above the card
    primaryBorderColor: '#5c6b74', // ink.low — NEUTRAL, not cyan (P4)
    primaryTextColor: '#eaf1f5', //   ink.high — node labels
    lineColor: '#5c6b74', //          ink.low — neutral edges
    secondaryColor: '#0f1419', //     surface.raised
    tertiaryColor: '#0a0e12', //      surface.panel
  },
  // Opt-in. The semantic hue.* palette, for complex flows where a single ink
  // weight stops being legible and branches need to be told apart by color.
  hue: {
    primaryColor: '#141c24', //         surface.hover — fill stays dark for contrast
    primaryBorderColor: '#818cf8', //   hue.open (indigo)
    primaryTextColor: '#eaf1f5', //     ink.high
    lineColor: '#6fcff6', //            hue.waiting (sky) — edge/branch accent
    secondaryColor: '#0f1419', //       surface.raised
    secondaryBorderColor: '#4fe0a6', // hue.resolved (emerald)
    secondaryTextColor: '#eaf1f5', //   ink.high
    tertiaryColor: '#0a0e12', //        surface.panel
    tertiaryBorderColor: '#ffc266', //  hue.discussing (amber)
    tertiaryTextColor: '#eaf1f5', //    ink.high
  },
}

// Shared across both treatments: the card defaults to mono and a diagram is
// structural, so mono fits; 11px matches the Slate meta scale.
const SHARED_THEME_VARIABLES = {
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: '11px',
}

/** The expanded ("lightbox") view of a diagram, at readable natural size.
 *
 *  PORTALED TO document.body ON PURPOSE — do not inline it. The Slate lives
 *  inside the infinite canvas, which applies `transform: translate(...) scale(...)`
 *  to widget containers. A CSS transform re-roots `position: fixed` onto the
 *  transformed ancestor instead of the viewport, so a fixed overlay rendered in
 *  place lands displaced and scaled, far from the cursor. The portal escapes the
 *  transform. (Same reasoning as FileUploadConfirmModal.) */
function MermaidExpanded({ svg, onClose }: { svg: string; onClose: () => void }): React.ReactElement {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      data-testid="mermaid-expanded"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-8"
      onClick={onClose}
    >
      <div
        // data-scrollable: the canvas wheel handler pans/zooms unless a hovered
        // element opts out, so the expanded diagram keeps its own scroll.
        data-scrollable
        data-testid="mermaid-expanded-panel"
        className="relative max-h-[90vh] max-w-[90vw] overflow-auto scrollbar-thin rounded border border-hairline bg-surface-raised p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close diagram"
          className="absolute top-2 right-2 text-ink-ctrl hover:text-ink-high transition-colors"
        >
          <span className="material-symbols-outlined text-base">close</span>
        </button>
        {/* max-w-none: readable natural size here, unlike the scaled-to-fit inline
            view. The panel scrolls if the diagram is bigger than the viewport. */}
        <div className="[&_svg]:max-w-none [&_svg]:h-auto" dangerouslySetInnerHTML={{ __html: svg }} />
      </div>
    </div>,
    document.body,
  )
}

/** Render an agent-supplied Mermaid `source` into a host-themed SVG, async, and
 *  self-degrading: a parse error or a failed chunk-load becomes a small inline
 *  amber notice (styled like the renderer's NodeFallback) — it never throws, so
 *  a bad diagram can't trip the per-surface error boundary and the surface's
 *  other nodes still render.
 *
 *  `theme` is the author's per-diagram choice of treatment; anything unknown
 *  falls back to the neutral 'ink' default. */
export function MermaidComponent({
  source,
  theme,
}: {
  source: string
  theme?: unknown
}): React.ReactElement {
  // SVG in state, not a ref (see file note): the success div is unmounted while
  // loading, so a ref would be null the moment render() resolves.
  const [svg, setSvg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const resolvedTheme = normalizeTheme(theme)
  const close = useCallback(() => setExpanded(false), [])

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setErrorMsg(null)

    // Empty/whitespace source: degrade immediately, don't call mermaid.render
    // (it would throw on empty input anyway).
    if (source.trim() === '') {
      setErrorMsg('empty diagram')
      return
    }

    const id = `a2ui-mermaid-${++mermaidIdCounter}`

    import('mermaid').then(async (mod) => {
      if (cancelled) return
      const mermaid = mod.default
      mermaid.initialize({
        startOnLoad: false,
        // Without this a parse failure makes mermaid paint its "bomb" graphic
        // into document.body (we pass no container) and orphan it over the canvas.
        // We catch the throw and render our own degrade line, so suppress it.
        suppressErrorRendering: true,
        // Content is agent-authored / untrusted. 'strict' encodes HTML in labels,
        // disables click-handlers/JS directives, and runs mermaid's internal
        // DOMPurify sanitize. NOT 'sandbox' — that renders into an iframe and
        // breaks host theming/sizing. Unchanged by the author's theme choice.
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: { ...SHARED_THEME_VARIABLES, ...MERMAID_THEMES[resolvedTheme] },
      })
      try {
        const { svg: rendered } = await mermaid.render(id, source)
        if (cancelled) return
        setSvg(rendered)
      } catch (err) {
        if (cancelled) return
        setErrorMsg(err instanceof Error ? err.message : 'invalid mermaid syntax')
      }
    }).catch((err) => {
      // The mermaid chunk itself failed to load (e.g. a stale /assets/*.js after
      // a rebuild). Without this catch the block hangs on "Rendering diagram…"
      // forever — surface a reload hint instead.
      if (cancelled) return
      const detail = err instanceof Error ? err.message : 'unknown error'
      setErrorMsg(`couldn't load the diagram renderer (${detail}) — try reloading the page`)
    })

    return () => { cancelled = true }
  }, [source, resolvedTheme])

  if (errorMsg !== null) {
    // Degrade line styled to match the renderer's NodeFallback — a small inline
    // amber notice, not a crash.
    return <span className="text-xs italic text-amber-300/80">⚠ diagram: {errorMsg}</span>
  }
  if (svg === null) {
    return <div className="text-xs font-mono text-ink-low py-2">Rendering diagram...</div>
  }
  return (
    <>
      {/* Inline: SCALED TO FIT the column — never natural-size overflow and never
          a horizontal scrollbar, because the Slate scroll body is overflow-x-hidden
          (#126). `max-w-full` + `h-auto` on the SVG shrinks it proportionally via
          its viewBox (and never enlarges a small one); `overflow-hidden` on the
          wrapper is the belt-and-braces guard. Click opens the readable view. */}
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label="Expand diagram"
        title="Click to expand"
        className="block w-full my-1 overflow-hidden text-left cursor-zoom-in"
      >
        <div className="[&_svg]:max-w-full [&_svg]:h-auto" dangerouslySetInnerHTML={{ __html: svg }} />
      </button>
      {expanded && <MermaidExpanded svg={svg} onClose={close} />}
    </>
  )
}

// A2UI `Mermaid` catalog component (Slate S1): turns an agent-supplied Mermaid
// definition string into a laid-out, dark-themed SVG. Client-only — mermaid is
// dynamically imported so it stays in its own lazy chunk and never reaches the
// React-free server bundle (schema.ts / controls.ts / followUps.ts). The catalog
// (catalog.tsx) is the only importer, and the catalog is imported only by the
// client A2uiRenderer.
//
// Pattern ported from the file-editor's MermaidBlock
// (src/plugins/file-editor/src/MarkdownRenderer.tsx): the SVG is held in state
// (a ref deadlocks — the target div is unmounted while loading, so a ref would
// be null the moment render() resolves), the effect is keyed on `source` with a
// `cancelled` flag, and mermaid is imported inside the effect.
//
// Two deliberate divergences from that precedent:
//   1. THEME (D7 / P4): the Slate design language reserves cyan (#00f0ff) for the
//      live edge only — "Static surfaces stay neutral so liveness stands out."
//      A static diagram therefore uses NEUTRAL ink borders/edges (ink.low
//      #5c6b74), NOT the cyan the file-editor block uses. Do not copy that cyan.
//   2. SECURITY (D6): content is agent-authored and reaches us through a
//      passthrough schema, so `source` is untrusted. `securityLevel: 'strict'` is
//      pinned explicitly (encodes HTML in labels, disables click/JS directives,
//      routes output through mermaid's DOMPurify) rather than left to the default.
import { useEffect, useState } from 'react'

// Module-scoped monotonic id so each rendered diagram gets a unique DOM id
// (mermaid.render needs a unique id per call). Kept out of component state so a
// re-render doesn't churn it.
let mermaidIdCounter = 0

// Slate dark-surface theme (D7). Values are the tokens from tailwind.theme.js;
// edges/borders are NEUTRAL ink (ink.low), never cyan (P4 — cyan is the live edge).
// TODO(light-theme): when a light Slate palette exists, read a theme signal here
// and swap these themeVariables — a future light mode is then a one-function
// change. Dark-only today (no prefers-color-scheme / data-theme in these widgets).
const SLATE_THEME_VARIABLES = {
  primaryColor: '#141c24', //     surface.hover — nodes one lightness step above the card
  primaryBorderColor: '#5c6b74', // ink.low — NEUTRAL, not cyan (P4)
  lineColor: '#5c6b74', //          ink.low — neutral edges (P4)
  primaryTextColor: '#eaf1f5', //   ink.high — node labels
  secondaryColor: '#0f1419', //     surface.raised
  tertiaryColor: '#0a0e12', //      surface.panel
  fontFamily: '"JetBrains Mono", monospace',
  fontSize: '11px',
} as const

/** Render an agent-supplied Mermaid `source` into a dark-themed SVG, async, and
 *  self-degrading: a parse error or a failed chunk-load becomes a small inline
 *  amber notice (styled like the renderer's NodeFallback) — it never throws, so
 *  a bad diagram can't trip the per-surface error boundary and the surface's
 *  other nodes still render. */
export function MermaidComponent({ source }: { source: string }): React.ReactElement {
  // SVG in state, not a ref (see file note): the success div is unmounted while
  // loading, so a ref would be null the moment render() resolves.
  const [svg, setSvg] = useState<string | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

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
        // Content is agent-authored / untrusted (D6). 'strict' encodes HTML in
        // labels, disables click-handlers/JS directives, and runs mermaid's
        // internal DOMPurify sanitize. NOT 'sandbox' — that renders into an
        // iframe and breaks host theming/sizing.
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: { ...SLATE_THEME_VARIABLES },
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
  }, [source])

  if (errorMsg !== null) {
    // Degrade line styled to match the renderer's NodeFallback (D8) — a small
    // inline amber notice, not a crash.
    return <span className="text-xs italic text-amber-300/80">⚠ diagram: {errorMsg}</span>
  }
  if (svg === null) {
    return <div className="text-xs font-mono text-ink-low py-2">Rendering diagram...</div>
  }
  // Wide diagrams scroll inside their own box (R2) — never widen the card.
  return (
    <div
      className="overflow-x-auto my-1 [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

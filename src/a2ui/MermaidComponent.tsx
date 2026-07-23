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
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// Module-scoped monotonic id so each rendered diagram gets a unique DOM id
// (mermaid.render needs a unique id per call). Kept out of component state so a
// re-render doesn't churn it.
let mermaidIdCounter = 0

// SHARED-GLOBAL HAZARD (read before touching the effect below).
// mermaid's config is *module-global*: `initialize()` rewrites its siteConfig
// from scratch (mermaid's own setSiteConfig starts from defaultConfig, so an
// initialize elsewhere DROPS whatever we set), and `render()` re-reads that
// config at several points across its own awaits. Two initialize+render pairs
// that interleave therefore repaint each other. Since the author now picks a
// theme PER DIAGRAM, two Slate diagrams mounting in the same commit would
// otherwise both land on whichever palette initialized last.
//
// Fix: every initialize+render pair goes through this one promise chain, so a
// pair is never in flight while another one initializes.
//
// This can only serialize OUR calls. The file-editor's MermaidBlock
// (src/plugins/file-editor/src/MarkdownRenderer.tsx) initializes the same global
// with its own cyan theme and is not on this chain, so a concurrently-rendering
// file-editor diagram can still tint a Slate diagram. Security is NOT at risk:
// that component leaves `securityLevel` unset, which is mermaid's `'strict'`
// default — the same value we pin — and mermaid keeps securityLevel /
// suppressErrorRendering / maxTextSize on its `secure` list, which neither an
// author directive nor a config merge can weaken.
let mermaidRenderQueue: Promise<void> = Promise.resolve()

/** Longest a single render may hold the queue. mermaid lazily imports a chunk per
 *  diagram TYPE from inside render(), so a stalled network can leave one render
 *  unsettled forever — and a strictly serial chain would then strand every later
 *  diagram on "Rendering diagram…". The slot releases after this either way. The
 *  released render still finishes and still paints; it just stops blocking. */
export const QUEUE_SLOT_TIMEOUT_MS = 10_000

/** Run `task` after every previously-enqueued mermaid render has settled (or
 *  timed out of its slot).
 *
 *  Exported for its own unit test only — the slot-timing semantics are the whole
 *  point of this helper and are impractical to drive through the component (fake
 *  timers and React's async `act` don't compose). Nothing else should call it. */
export function enqueueMermaidRender(task: () => Promise<void>): Promise<void> {
  const prev = mermaidRenderQueue
  const run = prev.then(task, task)
  // The slot timer ARMS WHEN THE SLOT IS ACQUIRED, not at enqueue — hence the
  // extra `prev.then(...)` hop. Arming it at the call site would start every
  // backlogged diagram's clock at the same instant, so one stall would expire
  // all of them at once and release the whole backlog concurrently — the exact
  // interleave this queue exists to prevent. Swallow on the chain itself so one
  // failure can't poison every later render.
  mermaidRenderQueue = prev.then(
    () => new Promise<void>((advance) => {
      const slot = setTimeout(advance, QUEUE_SLOT_TIMEOUT_MS)
      void run.then(() => undefined, () => undefined).then(() => {
        clearTimeout(slot)
        advance()
      })
    }),
    () => undefined,
  )
  return run
}

/** Hard ceiling on an authored definition, mirroring mermaid's own default
 *  `maxTextSize`. mermaid would swap a bigger definition for its own
 *  "maximum text size exceeded" *picture*; degrading here instead keeps the
 *  failure on this component's amber-line contract, and bounds the work the
 *  directive strip below has to do on a hostile source. */
export const MAX_SOURCE_LENGTH = 50_000

// A mermaid definition carries TWO author-controlled config channels, and both
// merge OVER the host config for every key that isn't on mermaid's `secure` list
// (mermaid's preprocessDiagram: front matter first, then directives). `source` is
// agent-authored, so without this strip an author could:
//   - set `themeVariables` and reintroduce the reserved live-edge cyan, which the
//     P4 guard test can't see (it inspects the config object, not the SVG);
//   - set `flowchart.useMaxWidth:false`, which makes mermaid emit a fixed pixel
//     width instead of `width="100%"`. The inline wrapper's `overflow-hidden`
//     would then CLIP the diagram rather than scale it — silently cutting off the
//     right side with no scrollbar, i.e. the #126 failure this component exists
//     to prevent.
// The host owns theming and sizing, so both channels come out. (securityLevel,
// suppressErrorRendering and maxTextSize are on mermaid's `secure` list and were
// never reachable this way — this is about theming and sizing, not security.)
//
// 1. YAML front matter, whose `config:` key is a full config override. Mermaid's
//    own frontMatterRegex, verbatim, so the strip and the parse agree on where
//    the block ends. The block also carries `title:`, which goes with it — the
//    Slate authoring contract never offered front matter in the first place.
const FRONT_MATTER_RE = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s
// 2. `%%{…}%%` directives, anywhere in the definition. Mermaid's own
//    directiveRegex, verbatim — the same one its removeDirectives() uses to clear
//    directives out of the diagram body, so this strip and mermaid's parse agree
//    exactly on what a directive is (including that an unterminated one runs to
//    the end). Matching the KEY instead would be wrong: mermaid's detectInit
//    filters keys with `key.match(/(?:init\b)|(?:initialize\b)/)`, a SUBSTRING
//    test, so `%%{xinit: …}%%` and `%%{preinitialize: …}%%` are honoured too.
//    Every directive goes; mermaid only honours init/initialize and wrap, and a
//    Slate author has no business with any of them.
const DIRECTIVE_RE = /%{2}\{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!\}%{2}).|\r?\n)*))?\s*(?:\}%{2})?/gi

/** How many strip passes are allowed before a source is declared hostile. Real
 *  content converges in one pass (a second only confirms nothing changed).
 *  A cap is needed because the loop is superlinear on adversarial input:
 *  FRONT_MATTER_RE is anchored and removes ONE block per pass, so ~5.5k stacked
 *  `---\na\n---` blocks inside MAX_SOURCE_LENGTH would otherwise mean ~5.5k
 *  full re-scans and re-allocations of a 50KB string — seconds of synchronous
 *  main-thread freeze, from agent-authored content, in a UI whose contract is
 *  that sluggishness is a bug. */
export const STRIP_PASS_LIMIT = 64

/** Strip both author-controlled config channels from a definition. Returns null
 *  when the source doesn't converge within STRIP_PASS_LIMIT passes — treat that
 *  as hostile and degrade rather than render it.
 *
 *  Runs to a FIXED POINT, not once. Both patterns are position-sensitive —
 *  front matter only counts at index 0 — so a single pass can *promote* a
 *  second block into a position mermaid would then honour: strip the leading
 *  front matter of `---…---\n---config:…---\ngraph TD` and the second block is
 *  suddenly at index 0. Repeat until nothing changes.
 *
 *  Within a pass the order matches mermaid's preprocessDiagram (front matter,
 *  then directives). */
export function stripAuthorConfig(source: string): string | null {
  let out = source
  for (let pass = 0; pass < STRIP_PASS_LIMIT; pass++) {
    const next = out.replace(FRONT_MATTER_RE, '').replace(DIRECTIVE_RE, '')
    if (next === out) return out
    out = next
  }
  return null
}

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
function MermaidExpanded({
  svg,
  onClose,
  restoreFocusTo,
}: {
  svg: string
  onClose: () => void
  restoreFocusTo: React.RefObject<HTMLElement | null>
}): React.ReactElement {
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // CAPTURE PHASE + stopPropagation, matching EntitySettingsDialog. InfiniteCanvas
    // keeps a bubble-phase window Escape handler that cancels drags, DESELECTS
    // EVERYTHING and refocuses the canvas (InfiniteCanvas.tsx). Both listeners sit
    // on `window`, so stopPropagation from a second bubble-phase listener would do
    // nothing — the canvas one registered first and would already have run.
    // Listening in the capture phase is what actually gets us in front of it, so
    // dismissing a diagram doesn't silently blow away the user's selection.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    // Move focus into the dialog on open and hand it back to the trigger on close,
    // so a keyboard user who expanded a diagram lands back where they were instead
    // of on document.body (where the next Escape/arrow goes to the canvas).
    //
    // Restoration covers USER-INITIATED closes (Escape / backdrop / close button),
    // which is the whole keyboard path. On the auto-refresh close the trigger
    // unmounts in the same commit, so the ref is already detached and this is a
    // no-op — deliberately: yanking focus onto a replacement element the user
    // never touched would be focus-stealing on a background refresh.
    closeButtonRef.current?.focus()
    return () => { restoreFocusTo.current?.focus() }
  }, [restoreFocusTo])

  return createPortal(
    <div
      data-testid="mermaid-expanded"
      role="dialog"
      aria-modal="true"
      aria-label="Expanded diagram"
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
          ref={closeButtonRef}
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
  const triggerRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    let cancelled = false
    const cleanup = () => { cancelled = true }
    setSvg(null)
    setErrorMsg(null)
    // A surface that refreshes itself would otherwise blink the reader's expanded
    // diagram closed (svg → null unmounts it) and pop it back open when the new
    // SVG lands — or re-open it later behind a degrade line. Reset with the render.
    setExpanded(false)

    // Bound the work before touching an agent-authored string (see MAX_SOURCE_LENGTH).
    if (source.length > MAX_SOURCE_LENGTH) {
      setErrorMsg(`diagram too large (${source.length} characters; limit ${MAX_SOURCE_LENGTH})`)
      return cleanup
    }

    // The host owns theming and sizing — an author's own config does not.
    const definition = stripAuthorConfig(source)
    if (definition === null) {
      // Name the cause so an author iterating on a surface knows what to remove.
      // Stated in PASSES, the unit the loop actually counts: n stacked blocks cost
      // n+1 passes (n removals plus the one that confirms no change), so quoting a
      // block limit would be off by one and send them to trim to a size that fails
      // again. It also avoids over-committing to front matter as the only cause.
      setErrorMsg(`couldn't normalize the diagram source (stacked config blocks didn't resolve within ${STRIP_PASS_LIMIT} passes)`)
      return cleanup
    }

    // Empty/whitespace source: degrade immediately, don't call mermaid.render
    // (it would throw on empty input anyway).
    if (definition.trim() === '') {
      setErrorMsg('empty diagram')
      return cleanup
    }

    const id = `a2ui-mermaid-${++mermaidIdCounter}`

    void (async () => {
      let mermaid: (typeof import('mermaid'))['default']
      try {
        mermaid = (await import('mermaid')).default
      } catch (err) {
        // The mermaid chunk itself failed to load (e.g. a stale /assets/*.js after
        // a rebuild). Without this catch the block hangs on "Rendering diagram…"
        // forever — surface a reload hint instead. Scoped to the IMPORT alone, so a
        // failure inside render() can't be mislabelled as a chunk-load failure.
        if (cancelled) return
        const detail = err instanceof Error ? err.message : 'unknown error'
        setErrorMsg(`couldn't load the diagram renderer (${detail}) — try reloading the page`)
        return
      }
      if (cancelled) return

      // initialize() + render() must stay adjacent — see the queue note up top.
      await enqueueMermaidRender(async () => {
        if (cancelled) return
        try {
          mermaid.initialize({
            startOnLoad: false,
            // Without this a parse failure makes mermaid paint its "bomb" graphic
            // into document.body (we pass no container) and orphan it over the canvas.
            // We catch the throw and render our own degrade line, so suppress it.
            suppressErrorRendering: true,
            // Content is agent-authored / untrusted. 'strict' encodes HTML in labels,
            // disables click-handlers/JS directives, and runs mermaid's internal
            // DOMPurify sanitize. NOT 'sandbox' — that renders into an iframe and
            // breaks host theming/sizing. Unchanged by the author's theme choice,
            // and on mermaid's `secure` list so no directive can weaken it.
            securityLevel: 'strict',
            theme: 'base',
            themeVariables: { ...SHARED_THEME_VARIABLES, ...MERMAID_THEMES[resolvedTheme] },
          })
          const { svg: rendered } = await mermaid.render(id, definition)
          if (cancelled) return
          setSvg(rendered)
        } catch (err) {
          if (cancelled) return
          setErrorMsg(err instanceof Error ? err.message : 'invalid mermaid syntax')
        }
      })
    })().catch((err) => {
      // Last-resort net so nothing escapes as an unhandled rejection (which under
      // vitest fails the suite instead of the assertion). Unreachable by
      // construction — the queued task catches its own failures and the chunk load
      // has its own branch — so anything landing here is OUR defect, not bad
      // authored syntax. Say so rather than blaming the source, and keep the real
      // cause in the console since no degrade line can carry it usefully.
      console.warn('[a2ui] mermaid render pipeline failed unexpectedly', err)
      if (cancelled) return
      setErrorMsg('diagram renderer failed unexpectedly')
    })

    return cleanup
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
        ref={triggerRef}
        onClick={() => setExpanded(true)}
        aria-label="Expand diagram"
        title="Click to expand"
        className="block w-full my-1 overflow-hidden text-left cursor-zoom-in"
      >
        <div className="[&_svg]:max-w-full [&_svg]:h-auto" dangerouslySetInnerHTML={{ __html: svg }} />
      </button>
      {expanded && <MermaidExpanded svg={svg} onClose={close} restoreFocusTo={triggerRef} />}
    </>
  )
}

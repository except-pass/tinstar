// The host catalog (R15): maps A2UI component *type strings* to Tinstar's own
// Tailwind components, so an agent-authored notice renders in the host theme
// instead of a stock, self-styled A2UI catalog. This is the work R15 requires
// regardless — we are deliberately NOT using web_core's `basic_catalog`, whose
// components ship their own styles and defeat host theming.
//
// The catalog is a bounded, read-only set of static-content types. A `component`
// string the catalog does not know falls to the renderer's degrade path (R16) —
// never a throw, never a blank. Standard A2UI names (Text, Column, Row, List,
// Card, Divider) are honored; `Link` and `Code` are host additions in the
// "roundup" catalog for the two static-content shapes the base vocabulary lacks.
// `Mermaid` is a host addition too — the one async/stateful (yet still read-only)
// entry, drawing an agent-supplied diagram string as a themed SVG (Slate S1).
// `Stepper` is a host addition as well — the status-colored progress rail (Slate
// S3). It exists because A2UI's contract is "JSON carries structure, never
// color": no authored Column/Text combination can say "this phase is DONE and
// that one is LIVE", so the status vocabulary has to live in the catalog.
//
// Classes mirror the markdown styling slice 1 applied in RoundupWidget, so the
// A2UI output is visually identical to the markdown it replaces.
import type { ReactNode } from 'react'
import type { A2uiComponent } from '../domain/types'
import { ChoiceControl, TextInputControl, SubmitControl } from './controlComponents'
import { MermaidComponent } from './MermaidComponent'

/** A catalog entry renders one node given its already-resolved, already-rendered
 *  child elements (the renderer owns tree-walking, ref resolution, and cycle
 *  guarding; entries stay pure and presentational). */
export interface CatalogEntry {
  render(node: A2uiComponent, children: ReactNode[]): ReactNode
}

/** Read a string-valued prop, coercing anything dynamic (a data binding or
 *  function-call object — deferred to the interactivity slice) or absent to ''.
 *  Read-only rendering shows the static form and ignores the dynamic part. */
function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Return a safe href, or '' to render the label as plain text instead. Content
 *  is agent-authored and A2UI's component schema is `.passthrough()`, so `url` is
 *  never scheme-validated upstream — a `javascript:`/`data:` url in an <a href>
 *  would execute in Tinstar's origin. Allow only http(s) and same-origin relative
 *  paths (leading `/` or `#`); everything else falls back to a non-link span. */
function safeHref(url: string): string {
  if (url.startsWith('/') || url.startsWith('#')) return url
  try {
    const proto = new URL(url).protocol
    return proto === 'http:' || proto === 'https:' ? url : ''
  } catch {
    return ''
  }
}

/** Text: the heading/paragraph primitive. `variant` h1–h5 render as scaled
 *  headings; caption/body (and the default) render as paragraph text. */
function textVariantClass(variant: unknown): string {
  switch (variant) {
    // Headlines/subheads: Chakra Petch (display), high ink. Sharp, tight leading.
    case 'h1': return 'font-display text-[15px] font-semibold leading-tight text-ink-high mt-2 mb-1'
    case 'h2': return 'font-display text-[13.5px] font-semibold leading-tight text-ink-high mt-2 mb-1'
    case 'h3': return 'font-display text-[12.5px] font-semibold text-ink-high mt-1.5 mb-1'
    // Section H4/H5: mono, 11px, caps, wide tracking, low ink — a quiet label.
    case 'h4':
    case 'h5': return 'font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-low mt-2 mb-1'
    // Caption: a quieter supporting aside. Reading sans — pinned so it doesn't
    // inherit the run card's terminal mono.
    case 'caption': return 'font-sans text-[12.5px] text-ink-low my-1'
    // Body: neutral sans, comfortable reading measure, mid ink. `font-sans` is
    // load-bearing — the surrounding run card defaults to mono, so prose must pin
    // the reading face explicitly (only labels/code/headlines override it). Never
    // the display face.
    default: return 'font-sans text-[14px] leading-[1.6] text-ink-mid my-1'
  }
}

// ---------------------------------------------------------------------------
// Stepper (Slate S3) — a status-colored vertical progress rail.
//
// The four statuses are deliberately NOT `PointStatus`: a progress phase is not
// a point lifecycle. `pending` (not started) · `active` (the live edge) · `done`
// (finished) · `skipped` (deliberately not run).
// ---------------------------------------------------------------------------

type StepStatus = 'pending' | 'active' | 'done' | 'skipped'

interface ParsedStep {
  label: string
  status: StepStatus
  detail?: string
}

const STEP_STATUSES = new Set<string>(['pending', 'active', 'done', 'skipped'])

/** Coerce a passthrough `steps` prop into renderable rows. A2UI component props
 *  are `.passthrough()` / `unknown`, so this is the only gate between an agent's
 *  JSON and the DOM: it is TOTAL BY CONSTRUCTION — every branch returns, nothing
 *  throws, and garbage yields `[]` (the caller's degrade path) rather than a
 *  crash that would blank the whole surface (R16). */
function parseSteps(value: unknown): ParsedStep[] {
  if (!Array.isArray(value)) return []
  const out: ParsedStep[] = []
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const rec = raw as Record<string, unknown>
    // A row with no readable label has nothing to show — drop it, keep the rest.
    const label = str(rec.label).trim()
    if (!label) continue
    const status: StepStatus =
      typeof rec.status === 'string' && STEP_STATUSES.has(rec.status)
        ? (rec.status as StepStatus)
        : 'pending'
    const detail = str(rec.detail).trim()
    out.push(detail ? { label, status, detail } : { label, status })
  }
  return out
}

// One tone per status, LITERAL class strings (no interpolated fragments) so
// Tailwind's JIT actually emits them — the same discipline OpenPointsSurface's
// PILL_TONE uses. `done` → hue.resolved (emerald, settled). `active` → primary
// cyan + the live glow, the one legitimate cyan use (P4 · cyan means live: the
// active phase IS the live edge). `pending` → the faint resting rail.
// `skipped` → hue.dismissed (slate, off-track).
const STEP_NODE: Record<StepStatus, string> = {
  done: 'bg-hue-resolved text-surface-base',
  active: 'bg-primary text-surface-base shadow-[0_0_14px_rgba(0,240,255,0.10)]',
  pending: 'bg-primary/12 text-ink-low',
  skipped: 'bg-hue-dismissed text-surface-base',
}

// Label ink tracks importance, not just status: the live phase is the only one
// at high ink; finished work sits at mid; not-yet and never-ran sit at low.
const STEP_LABEL: Record<StepStatus, string> = {
  done: 'text-ink-mid',
  active: 'text-ink-high',
  pending: 'text-ink-low',
  skipped: 'text-ink-low line-through',
}

// The connector below a row: emerald once the phase is behind us, faint ahead.
const STEP_CONNECTOR: Record<StepStatus, string> = {
  done: 'bg-hue-resolved/40',
  active: 'bg-primary/25',
  pending: 'bg-primary/12',
  skipped: 'bg-hue-dismissed/30',
}

/** The glyph inside a step node. Only `done` earns a mark; the rest are dots,
 *  so the rail reads as progress rather than as four different icons. */
function stepGlyph(status: StepStatus): string {
  return status === 'done' ? '✓' : ''
}

function StepperRail({ steps }: { steps: ParsedStep[] }): ReactNode {
  return (
    <div className="flex flex-col my-1" data-testid="stepper">
      {steps.map((step, i) => (
        <div
          key={`${i}-${step.label}`}
          className="flex flex-row gap-2.5"
          data-testid="stepper-step"
          data-status={step.status}
        >
          {/* Rail column: the status node, plus the connector down to the next. */}
          <div className="flex flex-col items-center">
            <span
              className={`mt-[3px] h-3.5 w-3.5 shrink-0 rounded-full flex items-center justify-center font-mono text-[9px] leading-none ${STEP_NODE[step.status]}`}
              data-testid="stepper-node"
              aria-hidden="true"
            >
              {stepGlyph(step.status)}
            </span>
            {i < steps.length - 1 && (
              <span
                className={`w-px flex-1 min-h-[10px] ${STEP_CONNECTOR[step.status]}`}
                data-testid="stepper-connector"
                aria-hidden="true"
              />
            )}
          </div>
          {/* Content column: a mono label (meta, not prose) + an optional sans
              detail caption. `font-sans` on the detail is load-bearing — the run
              card defaults to mono, so reading prose must pin the sans face. */}
          <div className={`min-w-0 ${i < steps.length - 1 ? 'pb-2' : ''}`}>
            <div
              className={`font-mono text-[11.5px] leading-[1.5] ${STEP_LABEL[step.status]}`}
              data-testid="stepper-label"
            >
              {step.label}
            </div>
            {step.detail && (
              <div
                className="font-sans text-[12.5px] leading-[1.5] text-ink-low mt-0.5"
                data-testid="stepper-detail"
              >
                {step.detail}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

export const CATALOG: Record<string, CatalogEntry> = {
  Text: {
    render: (node) => <p className={textVariantClass(node.variant)}>{str(node.text)}</p>,
  },
  Column: {
    // Layout only, no box. Gap-inside-a-surface = 8px (the design's inner rhythm).
    render: (_node, children) => <div className="flex flex-col gap-2">{children}</div>,
  },
  Row: {
    // Wraps and aligns to baseline; gap 12px.
    render: (_node, children) => <div className="flex flex-row flex-wrap gap-3 items-baseline">{children}</div>,
  },
  List: {
    render: (node, children) => {
      const ordered = node.listStyle === 'ordered'
      const Tag = ordered ? 'ol' : 'ul'
      const cls = `${ordered ? 'list-decimal' : 'list-disc'} pl-5 my-1 font-sans text-[14px] leading-[1.6] text-ink-mid marker:text-ink-low`
      return <Tag className={cls}>{children.map((c, i) => <li key={i} className="my-1">{c}</li>)}</Tag>
    },
  },
  Card: {
    // A2UI Card carries a single `child`; the renderer resolves it into children[0].
    // Nested cards step UP to surface.hover so nesting reads by lightness, not by border.
    render: (_node, children) => (
      <div className="rounded border border-hairline bg-surface-hover p-3 my-1">{children[0] ?? null}</div>
    ),
  },
  Divider: {
    render: () => <hr className="my-2 border-hairline" />,
  },
  Link: {
    render: (node) => {
      const url = str(node.url)
      const label = str(node.text) || url
      const href = safeHref(url)
      // P1 — chrome quiet: a link is navigation, not meaning, so it stays ink (no hue),
      // underlined and brightening on hover, with a ↗ affordance for the external jump.
      if (!href) return <span className="font-sans text-ink-mid">{label}</span>
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="font-sans text-ink-mid underline decoration-hairline underline-offset-2 hover:text-ink-high"
        >
          {label} <span className="text-ink-low">↗</span>
        </a>
      )
    },
  },
  Code: {
    render: (node) => (
      <pre className="font-mono text-[12px] bg-surface-hover border border-hairline rounded p-2 overflow-x-auto my-1 text-ink-mid">
        <code>{str(node.text)}</code>
      </pre>
    ),
  },
  // Interactive controls (U2/U3). These render host-themed form controls whose
  // value is host-owned via the notice form context; a control rendered without
  // an interactive form context (read-only) shows a disabled/static form. A
  // malformed control (e.g. a Choice with no valid options) degrades to an inline
  // marker inside the component itself — never a throw (KTD4/R16).
  Choice: {
    render: (node) => <ChoiceControl node={node} />,
  },
  TextInput: {
    render: (node) => <TextInputControl node={node} />,
  },
  Submit: {
    render: (node) => <SubmitControl node={node} />,
  },
  // `FollowUp` is a DECLARATION, not a body element: the agent names a question it
  // expects for this notice, and the widget surfaces it as a chip in the notice's
  // ask panel — the compact secondary surface beside the card, never inside it.
  // Rendering it here would put an ask affordance in the middle of the prose and
  // grow the card, which is exactly what the ask panel exists to prevent. So the
  // catalog KNOWS the type (it is not an unknown-component fallback, and it does not
  // draw a "⚠ unsupported" marker at the user) and renders nothing in place.
  FollowUp: {
    render: () => null,
  },
  // Mermaid: the one async/stateful — but still read-only — catalog entry. It
  // turns an agent-supplied Mermaid `source` string into a host-themed SVG
  // diagram (a picture, not an answered form). Rendering lives in
  // MermaidComponent (mermaid is client-only, dynamically imported into its own
  // lazy chunk — it must never reach the React-free server bundle). Like every
  // other entry it self-degrades: a bad/empty source becomes a small inline
  // amber notice, never a throw. `str()` coerces a missing/non-string source to
  // '' → the empty-diagram degrade path.
  //
  // `theme` is the author's per-diagram treatment choice ('ink' monochrome by
  // default, 'hue' for the semantic palette). It is passed through RAW, not via
  // `str()`, because MermaidComponent's own `normalizeTheme` is the single place
  // that decides what counts as valid — anything unknown falls back to 'ink'.
  Mermaid: {
    render: (node) => <MermaidComponent source={str(node.source)} theme={node.theme} />,
  },
  // Stepper: a read-only, status-colored vertical progress rail. A leaf — it
  // takes no children and reads only its passthrough `steps` array of
  // `{ label, status, detail? }`. `steps` is passed RAW to `parseSteps`, which
  // is the single place that decides what counts as a valid row; anything else
  // (a string, an object, rows with no label, an unknown status) is coerced or
  // dropped there. An entirely unusable `steps` degrades to a small inline
  // amber marker, matching the renderer's NodeFallback tone — never a throw,
  // never a blank surface (R16).
  Stepper: {
    render: (node) => {
      const steps = parseSteps(node.steps)
      if (steps.length === 0) {
        return <span className="text-xs italic text-amber-300/80">⚠ stepper: no steps to show</span>
      }
      return <StepperRail steps={steps} />
    },
  },
}

/** True when the host catalog knows how to render this component type. */
export function isSupported(componentType: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOG, componentType)
}

/** The component types that carry children by id (the renderer resolves and
 *  recurses through these). `Card` uses a single `child`; the layout/list types
 *  use a `children` array. Everything else is a leaf. */
export function childIdsOf(node: A2uiComponent): string[] {
  if (Array.isArray(node.children) && node.children.every(c => typeof c === 'string')) {
    return node.children as string[]
  }
  if (typeof node.child === 'string') return [node.child]
  return []
}

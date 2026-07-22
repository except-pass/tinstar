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
//
// Classes mirror the markdown styling slice 1 applied in RoundupWidget, so the
// A2UI output is visually identical to the markdown it replaces.
import type { ReactNode } from 'react'
import type { A2uiComponent } from '../domain/types'
import { ChoiceControl, TextInputControl, SubmitControl } from './controlComponents'

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
    // Caption: a quieter supporting aside.
    case 'caption': return 'text-[12.5px] text-ink-low my-1'
    // Body: neutral sans, comfortable reading measure, mid ink. Never the display face.
    default: return 'text-[14px] leading-[1.6] text-ink-mid my-1'
  }
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
      const cls = `${ordered ? 'list-decimal' : 'list-disc'} pl-5 my-1 text-[14px] leading-[1.6] text-ink-mid marker:text-ink-low`
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
      if (!href) return <span className="text-ink-mid">{label}</span>
      return (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-ink-mid underline decoration-hairline underline-offset-2 hover:text-ink-high"
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

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
import type { A2uiComponent } from '../../../../domain/types'

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

/** Text: the heading/paragraph primitive. `variant` h1–h5 render as scaled
 *  headings; caption/body (and the default) render as paragraph text. */
function textVariantClass(variant: unknown): string {
  switch (variant) {
    case 'h1': return 'text-base font-bold mt-2 mb-1'
    case 'h2': return 'text-sm font-bold mt-2 mb-1'
    case 'h3': return 'text-sm font-semibold mt-1.5 mb-1'
    case 'h4':
    case 'h5': return 'text-xs font-semibold uppercase tracking-wide mt-1.5 mb-0.5'
    case 'caption': return 'text-xs text-neutral-400 my-1'
    default: return 'my-1'
  }
}

export const CATALOG: Record<string, CatalogEntry> = {
  Text: {
    render: (node) => <p className={textVariantClass(node.variant)}>{str(node.text)}</p>,
  },
  Column: {
    render: (_node, children) => <div className="flex flex-col gap-1">{children}</div>,
  },
  Row: {
    render: (_node, children) => <div className="flex flex-row flex-wrap gap-2 items-baseline">{children}</div>,
  },
  List: {
    render: (node, children) => {
      const ordered = node.listStyle === 'ordered'
      const Tag = ordered ? 'ol' : 'ul'
      const cls = ordered ? 'list-decimal pl-5 my-1' : 'list-disc pl-5 my-1'
      return <Tag className={cls}>{children.map((c, i) => <li key={i} className="my-0.5">{c}</li>)}</Tag>
    },
  },
  Card: {
    // A2UI Card carries a single `child`; the renderer resolves it into children[0].
    render: (_node, children) => (
      <div className="rounded-md border border-neutral-700 bg-neutral-800/50 p-2 my-1">{children[0] ?? null}</div>
    ),
  },
  Divider: {
    render: () => <hr className="my-2 border-neutral-700" />,
  },
  Link: {
    render: (node) => {
      const url = str(node.url)
      const label = str(node.text) || url
      if (!url) return <span className="text-sky-300">{label}</span>
      return (
        <a href={url} target="_blank" rel="noreferrer noopener" className="text-sky-300 underline hover:text-sky-200">
          {label}
        </a>
      )
    },
  },
  Code: {
    render: (node) => (
      <pre className="bg-neutral-800 p-2 rounded overflow-x-auto my-1 text-xs">
        <code>{str(node.text)}</code>
      </pre>
    ),
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

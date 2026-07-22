// The host-themed A2UI walker (R14/R15) with graceful degrade (R16).
//
// Read-only: it validates a notice's A2UI content, walks the flat component list
// from `root` resolving child references by id, and maps each supported type to a
// host Tailwind component via the catalog. It binds no data model, dispatches no
// actions, and touches none of web_core's runtime — that is the next slice.
//
// R16 is defense in depth against slice 1's lesson (a single non-string field
// crashed *every* card on the board). Three things converge on one readable
// outcome and never a blank card or a board-wide crash:
//   1. content that fails v0_9 validation at render → the malformed signal + a
//      best-effort readable text extraction;
//   2. an unsupported/unresolvable node mid-walk → a small inline marker, so the
//      rest of the tree still renders;
//   3. any unexpected throw during the walk → caught by a per-notice React error
//      boundary, isolating the bad notice from its siblings.
import { Component, type ErrorInfo, type ReactNode } from 'react'
import type { A2uiComponent, A2uiContent } from '../domain/types'
import { parseA2uiContent } from './schema'
import { CATALOG, childIdsOf, isSupported } from './catalog'
import { NoticeFormProvider, type NoticeFormState } from './controlComponents'

/** The R16 signal shown whenever a notice's content can't be rendered. Kept as a
 *  single exported constant so the API-reject path, the render-degrade path, and
 *  the tests all agree on one phrase. */
export const MALFORMED_SIGNAL = "This notice's content couldn't be rendered."

/** Bound on recursion depth. Depth alone is NOT enough: a shared ("diamond")
 *  reference is re-walked on every incoming edge, so a shallow description can
 *  still expand exponentially in total node count (see MAX_NODES). */
const MAX_DEPTH = 32

/** Hard cap on TOTAL nodes visited across the whole walk, decremented on every
 *  visit (including re-visits of a shared ref). This — not depth — is what stops
 *  a tiny hostile description like `c_i.children = [c_{i+1}, c_{i+1}]` from
 *  forcing 2^N renders and hanging the tab (R16: a bad notice can't hang it). */
const MAX_NODES = 500

/** Keys whose string values are human-readable content. Used by the degrade path
 *  to salvage something readable out of an invalid description. */
const READABLE_KEYS = new Set(['text', 'url', 'label', 'title', 'headline'])

/** Best-effort: pull readable strings out of an arbitrary (possibly invalid)
 *  value so a malformed notice still surfaces its words, not just an error line. */
export function extractReadableText(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH || value == null) return ''
  if (Array.isArray(value)) return value.map(v => extractReadableText(v, depth + 1)).filter(Boolean).join(' ')
  if (typeof value === 'object') {
    const out: string[] = []
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string') { if (READABLE_KEYS.has(k) && v.trim()) out.push(v.trim()) }
      else out.push(extractReadableText(v, depth + 1))
    }
    return out.filter(Boolean).join(' ')
  }
  return ''
}

/** The readable fallback (R16): the malformed signal plus any salvaged words. */
function DegradeFallback({ source }: { source: unknown }): ReactNode {
  const salvaged = extractReadableText(source)
  return (
    <div className="text-sm text-amber-300/90" role="note">
      <span className="italic">⚠ {MALFORMED_SIGNAL}</span>
      {salvaged && <div className="mt-1 text-neutral-300 whitespace-pre-wrap">{salvaged}</div>}
    </div>
  )
}

/** A small inline marker for one node the walker can't render (unsupported type
 *  or unresolvable ref). Non-throwing, so its siblings still render (R16). */
function NodeFallback({ label }: { label: string }): ReactNode {
  return <span className="text-xs italic text-amber-300/80">⚠ {label}</span>
}

/** Walk one node into a host-themed React tree. Pure; any throw is a bug caught
 *  by the surrounding error boundary. */
function walkNode(
  id: string,
  byId: Map<string, A2uiComponent>,
  seen: Set<string>,
  depth: number,
  budget: { remaining: number },
): ReactNode {
  // Total-node budget first: decremented on every visit, so a diamond-shaped
  // description that re-walks shared refs is bounded regardless of its depth.
  if (budget.remaining <= 0) return <NodeFallback label="content too large to render" />
  budget.remaining--
  if (depth > MAX_DEPTH) return <NodeFallback label="content nested too deeply" />
  if (seen.has(id)) return <NodeFallback label={`cyclic reference to "${id}"`} />
  const node = byId.get(id)
  if (!node) return <NodeFallback label={`missing component "${id}"`} />
  if (!isSupported(node.component)) {
    return <NodeFallback label={`unsupported component "${node.component}"`} />
  }
  const nextSeen = new Set(seen).add(id)
  const children = childIdsOf(node).map((childId, i) => (
    <WalkKey key={childId || i}>{walkNode(childId, byId, nextSeen, depth + 1, budget)}</WalkKey>
  ))
  return CATALOG[node.component]!.render(node, children)
}

/** Keyed wrapper so sibling children carry stable React keys without the catalog
 *  entries needing to thread keys themselves. */
function WalkKey({ children }: { children: ReactNode }): ReactNode {
  return <>{children}</>
}

/** Validate and walk content into a themed tree, or the readable fallback. This
 *  is the defense-in-depth revalidation (KTD4): even though the API already
 *  rejected malformed content, the renderer never trusts what reaches it. */
function renderContent(content: A2uiContent | undefined | null): ReactNode {
  const parsed = parseA2uiContent(content)
  if (!parsed) return <DegradeFallback source={content} />
  const byId = new Map<string, A2uiComponent>()
  for (const c of parsed.components) if (typeof c.id === 'string') byId.set(c.id, c)
  if (!byId.has(parsed.root)) return <DegradeFallback source={content} />
  return walkNode(parsed.root, byId, new Set(), 0, { remaining: MAX_NODES })
}

interface BoundaryProps { children: ReactNode; source?: unknown; onError?: (e: Error) => void }
interface BoundaryState { failed: boolean }

/** Per-notice React error boundary (R16). Wraps exactly one notice's body so an
 *  unexpected throw degrades that notice alone — sibling notices are untouched.
 *  Exported so the widget can wrap each notice independently and so it can be
 *  unit-tested in isolation. */
export class A2uiErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { failed: false }

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, _info: ErrorInfo): void {
    this.props.onError?.(error)
  }

  render(): ReactNode {
    if (this.state.failed) return <DegradeFallback source={this.props.source} />
    return this.props.children
  }
}

/** Render a notice's A2UI content, host-themed, degrading to a readable fallback
 *  on any malformed input (R16). The headline is the widget's responsibility and
 *  is always shown outside this component.
 *
 *  Pass `form` to make declared controls interactive (U3): the tree is wrapped in
 *  the notice form context so `Choice`/`TextInput`/`Submit` controls read and
 *  write host-owned state. Omit it (the default) for a read-only render, where
 *  any controls show disabled/static — the read-only posture slices 1–2 kept. */
export function A2uiRenderer({
  content,
  form,
}: {
  content: A2uiContent | undefined | null
  form?: NoticeFormState
}): ReactNode {
  const tree = renderContent(content)
  return (
    <A2uiErrorBoundary source={content}>
      {form ? <NoticeFormProvider value={form}>{tree}</NoticeFormProvider> : tree}
    </A2uiErrorBoundary>
  )
}

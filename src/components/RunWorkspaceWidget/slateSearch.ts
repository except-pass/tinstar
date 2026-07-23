// What the Slate's `/` filter actually searches (S6 U1).
//
// The naive haystack — headline + id + kind — searches fields the user cannot see.
// An expanded card never renders `headline`: its visible title is whatever heading
// the agent put in the A2UI body, and `id` is the author's slug. So filtering on
// those alone means typing a word you can plainly read on a card matches nothing,
// and the "No surface matches …" line reports an absence about a surface sitting
// right there.
//
// So the haystack also flattens the RENDERED body text out of the A2UI content.
// Pure and React-free, so the rule is unit-testable without a DOM.
import type { A2uiContent, SlateSurface } from '../../types'

/**
 * Props whose string content is (or contains) reading text in the A2UI catalog:
 * `text` (Text/Link), `label` (Stepper step, Choice option), `detail` (step caption),
 * `code` (Code block), `items` (List), and the containers that hold them. Structural
 * props (`component`, `id`, `variant`, `href`, `status`, `theme`) are deliberately
 * NOT searched — matching a surface because its body happens to contain the word
 * "column" would be worse than not matching at all.
 */
const READABLE_KEYS = new Set([
  'text', 'label', 'title', 'detail', 'caption', 'code', 'description',
  'items', 'steps', 'options', 'columns', 'rows',
])

/** Depth cap — an authored body is host-owned data, so a cyclic/absurdly nested
 *  one must cost a bounded walk rather than a stack overflow. */
const MAX_DEPTH = 8

function collect(value: unknown, out: string[], depth: number): void {
  if (depth > MAX_DEPTH) return
  if (typeof value === 'string') {
    if (value) out.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, out, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (READABLE_KEYS.has(k)) collect(v, out, depth + 1)
    }
  }
}

/** Every readable string in an A2UI body, in document order. */
export function bodyText(content: A2uiContent | undefined): string[] {
  if (!content || !Array.isArray(content.components)) return []
  const out: string[] = []
  for (const node of content.components) collect(node, out, 0)
  return out
}

/** The lowercased string the `/` filter matches a query against. */
export function surfaceHaystack(surface: SlateSurface): string {
  return [surface.headline ?? '', surface.id, surface.kind, ...bodyText(surface.body)]
    .join(' ')
    .toLowerCase()
}

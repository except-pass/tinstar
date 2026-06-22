// Best-effort DOM capture for a note drop point inside the proxied iframe.
// Everything is defensive: the iframe document is same-origin via the proxy,
// but any failure (cross-origin doc, missing APIs, mid-navigation) degrades to
// `undefined` ⇒ the note is stored coords-only. NOTE: the iframe document is a
// different JS realm — never use `instanceof HTMLImageElement` here; match tagName.
import type { BrowserNoteTarget } from '../../../../domain/types'
import { unproxyPath } from '../proxyPaths'

/** CSS.escape, guarded for realms/environments (jsdom) that lack it. */
const esc = (s: string): string => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s)

/** Best-effort short CSS selector: #id, else up-to-4-level tag.class:nth-child path. */
export function cssSelectorFor(el: Element): string {
  if (el.id) return `#${esc(el.id)}`
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && parts.length < 4) {
    const tag = cur.tagName.toLowerCase()
    if (tag === 'html' || tag === 'body') break
    if (cur.id) { parts.unshift(`#${esc(cur.id)}`); break }
    let part = tag
    // Skip variant/arbitrary utility classes (e.g. `hover:underline`, `p-[3px]`)
    // — low-information for an agent and selector-breaking — and CSS.escape the
    // rest, so a class like `w-1/2` is kept but escaped (w-1\/2) rather than
    // corrupting the selector.
    const cls = Array.from(cur.classList).filter(c => !/[:[]/.test(c)).slice(0, 2)
    if (cls.length) part += '.' + cls.map(esc).join('.')
    const parent: Element | null = cur.parentElement
    if (parent) part += `:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`
    parts.unshift(part)
    cur = parent
  }
  return parts.join(' > ')
}

/** Un-proxy an absolute URL that routes through /api/proxy/<nodeId>/…; pass others through. */
function unproxiedSrc(src: string, nodeId: string, currentUrl: string): string {
  try {
    const u = new URL(src)
    return unproxyPath(u.pathname, u.search, nodeId, currentUrl) ?? src
  } catch {
    return src
  }
}

/**
 * Capture DOM context at a viewport point in the proxied document.
 * Returns undefined when nothing useful is under the point (body/html), the
 * document blocks access, or elementFromPoint is unavailable (jsdom).
 */
export function captureTarget(
  doc: Document,
  viewportX: number,
  viewportY: number,
  nodeId: string,
  currentUrl: string,
): BrowserNoteTarget | undefined {
  try {
    const el = doc.elementFromPoint?.(viewportX, viewportY)
    if (!el) return undefined
    const tag = el.tagName.toLowerCase()
    if (tag === 'html' || tag === 'body') return undefined

    const target: BrowserNoteTarget = { tag }
    const selector = cssSelectorFor(el)
    if (selector) target.selector = selector

    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) {
      const clamp = (v: number) => Math.min(1, Math.max(0, v))
      target.within = {
        x: clamp((viewportX - r.left) / r.width),
        y: clamp((viewportY - r.top) / r.height),
      }
    }

    if (tag === 'img') {
      const src = (el as HTMLImageElement).src
      if (src) target.imageSrc = unproxiedSrc(src, nodeId, currentUrl)
      const alt = el.getAttribute('alt')
      if (alt) target.imageAlt = alt
    } else {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (text) target.text = text.slice(0, 120)
    }
    return target
  } catch {
    return undefined
  }
}

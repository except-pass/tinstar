// Per-widget pin context capture. Native widgets render in the host document,
// so at drop time `document.elementFromPoint(clientX, clientY)` returns the real
// element under the marker. We climb the DOM to build a human-readable label of
// what was pinned (the "immediate" thing) and where it lives (the "region"),
// which is then stored on the pin and folded into the submit message.
//
// Browser-style widgets render their content in a cross-document IFRAME — for
// those, elementFromPoint returns the <iframe> element, so we bail (the owning
// plugin enriches its own pins with richer DOM context). This util is the host
// fallback for everything that renders inline.

export interface PinCapturedContext {
  /** Human string, e.g. "CHANGED" or "TOKENS · in telemetry pane". */
  label: string
  /** The element tag under the point (lowercased). */
  tag: string
  /** Trimmed text of the element (<=80 chars). */
  text?: string
}

const MAX_ANCESTORS = 8
const IMMEDIATE_TEXT_CAP = 40 // a leaf-ish label shouldn't be a paragraph
const FALLBACK_TEXT_CAP = 80
const REGION_TEXT_CAP = 60

const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n).trimEnd() : s)

const humanizeTestid = (raw: string): string => collapse(raw.replace(/[-_]+/g, ' '))

/** Pin-system affordances/markers carry data-testid="pin-*"; never label them. */
const isPinSystem = (el: Element): boolean => {
  const tid = el.getAttribute?.('data-testid')
  return !!tid && tid.startsWith('pin-')
}

const INTERACTIVE_ROLES = new Set(['tab', 'button', 'link', 'menuitem', 'option'])

/** The specific thing pinned: an interactive/labeled element with short text. */
function immediateLabel(el: Element): string | undefined {
  const aria = collapse(el.getAttribute('aria-label'))
  if (aria) return cap(aria, IMMEDIATE_TEXT_CAP)

  const role = el.getAttribute('role') ?? ''
  const tag = el.tagName.toLowerCase()
  const interactive = INTERACTIVE_ROLES.has(role) || tag === 'button' || tag === 'a'
  if (interactive) {
    const t = collapse(el.textContent)
    if (t && t.length <= IMMEDIATE_TEXT_CAP) return t
  }
  return undefined
}

/** A leaf-ish own-text label: short, non-empty textContent for a small element. */
function leafLabel(el: Element): string | undefined {
  const t = collapse(el.textContent)
  if (t && t.length <= IMMEDIATE_TEXT_CAP) return t
  return undefined
}

const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4'])

/** The containing pane/section: heading, aria-label, or humanized testid. */
function regionLabel(el: Element): string | undefined {
  // data-pin-context is handled by the caller (authoritative); here we look for
  // softer region signals.
  const tag = el.tagName.toLowerCase()
  if (HEADING_TAGS.has(tag) || el.getAttribute('role') === 'heading') {
    const t = collapse(el.textContent)
    if (t) return cap(t, REGION_TEXT_CAP)
  }
  // A nested heading inside this ancestor (common: pane > h3 + body).
  const heading = el.querySelector?.('h1,h2,h3,h4,[role="heading"]')
  if (heading) {
    const t = collapse(heading.textContent)
    if (t) return cap(t, REGION_TEXT_CAP)
  }
  const aria = collapse(el.getAttribute('aria-label'))
  if (aria) return cap(aria, REGION_TEXT_CAP)
  const tid = el.getAttribute('data-testid')
  if (tid && !tid.startsWith('pin-')) {
    const h = humanizeTestid(tid)
    if (h) return cap(h, REGION_TEXT_CAP)
  }
  return undefined
}

export function captureWidgetContext(
  clientX: number,
  clientY: number,
  doc: Document = document,
): PinCapturedContext | undefined {
  const start = doc.elementFromPoint(clientX, clientY)
  if (!start) return undefined
  if (start.tagName === 'IFRAME') return undefined

  const tag = start.tagName.toLowerCase()
  const startText = collapse(start.textContent)

  let immediate: string | undefined
  let region: string | undefined
  let authoritativeRegion: string | undefined

  let el: Element | null = start
  let hops = 0
  while (el && hops < MAX_ANCESTORS) {
    if (!isPinSystem(el)) {
      // 1. Explicit opt-in region wins outright.
      const pinCtx = collapse(el.getAttribute('data-pin-context'))
      if (pinCtx && !authoritativeRegion) authoritativeRegion = cap(pinCtx, REGION_TEXT_CAP)

      // 2. Immediate label — first labeled/interactive ancestor, or leaf-ish text.
      if (!immediate) {
        immediate = immediateLabel(el) ?? (el === start ? leafLabel(el) : undefined)
      }

      // 3. Region label (soft) — nearest heading/aria/testid, kept distinct from immediate.
      if (!region) {
        const r = regionLabel(el)
        if (r && r !== immediate) region = r
      }
    }
    el = el.parentElement
    hops++
  }

  const finalRegion = authoritativeRegion ?? region
  let label = immediate ?? ''
  if (finalRegion && finalRegion !== label) {
    label = label ? `${label} · in ${finalRegion}` : `in ${finalRegion}`
  }
  // Fallback to the start element's own trimmed text.
  if (!label) label = cap(startText, FALLBACK_TEXT_CAP)
  if (!label) return undefined

  const out: PinCapturedContext = { label, tag }
  if (startText) out.text = cap(startText, FALLBACK_TEXT_CAP)
  return out
}

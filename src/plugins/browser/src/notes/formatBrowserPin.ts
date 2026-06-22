// Pure formatter: a single browser Pin → one human-readable prompt for the
// attached session. Ported from the old batch formatNotesPrompt, but per-pin
// (the browser now submits one pin at a time). Unit-tested independently of the
// React components.
import type { Pin } from '../../../../domain/pinSet'
import type { BrowserNoteTarget } from '../../../../domain/types'

/** Nine-cell grid word for a normalized in-element position ("lower-left", "center"…). */
export function regionWord(within: { x: number; y: number }): string {
  const col = within.x < 1 / 3 ? 'left' : within.x < 2 / 3 ? 'center' : 'right'
  const row = within.y < 1 / 3 ? 'upper' : within.y < 2 / 3 ? 'middle' : 'lower'
  if (row === 'middle' && col === 'center') return 'center'
  return `${row}-${col}`
}

/** Document-space anchor for a pin, read from the enriched context (browser
 *  writes docX/docY there) and falling back to the normalized viewport coords. */
function pinPoint(pin: Pin): { x: number; y: number } {
  const ctx = pin.context
  const x = typeof ctx?.docX === 'number' ? ctx.docX : pin.nx
  const y = typeof ctx?.docY === 'number' ? ctx.docY : pin.ny
  return { x, y }
}

function describeLocation(pin: Pin, t: BrowserNoteTarget | undefined): string {
  const { x, y } = pinPoint(pin)
  const at = `at (${Math.round(x)}, ${Math.round(y)})`
  if (!t) return `${at} on the page`
  if (t.imageSrc) {
    const name = t.imageSrc.split('/').pop() || t.imageSrc
    const alt = t.imageAlt ? ` (alt: "${t.imageAlt}")` : ''
    const region = t.within ? `, ${regionWord(t.within)}` : ''
    return `on <img> ${name}${alt}${region}, ${at}`
  }
  const text = t.text ? ` "${t.text}"` : ''
  const sel = t.selector ? ` (${t.selector})` : ''
  return `on <${t.tag}>${text}${sel}, ${at}`
}

/** Format ONE pin into a prompt: the page URL, the located target, and the comment. */
export function formatBrowserPin(pin: Pin): string {
  const url = pin.context?.url
  const target = pin.context?.target as BrowserNoteTarget | undefined
  const where = describeLocation(pin, target)
  const page = url ? `the page ${url}` : 'the page'
  return `I've marked up ${page}:\n\n[1] ${where}\n    → ${pin.comment || '(no comment)'}`
}

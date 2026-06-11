// Pure formatter: BrowserNote[] → one human-readable prompt for the attached
// session. Unit-tested independently of the React components.
import type { BrowserNote, BrowserNoteTarget } from '../../../../domain/types'

/** Nine-cell grid word for a normalized in-element position ("lower-left", "center"…). */
export function regionWord(within: { x: number; y: number }): string {
  const col = within.x < 1 / 3 ? 'left' : within.x < 2 / 3 ? 'center' : 'right'
  const row = within.y < 1 / 3 ? 'upper' : within.y < 2 / 3 ? 'middle' : 'lower'
  if (row === 'middle' && col === 'center') return 'center'
  return `${row}-${col}`
}

function describeLocation(n: BrowserNote, t: BrowserNoteTarget | undefined): string {
  const at = `at (${Math.round(n.x)}, ${Math.round(n.y)})`
  if (!t) return `${at} / (${Math.round(n.nx * 100)}%, ${Math.round(n.ny * 100)}%) on the page`
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

/** Format all UNSENT notes into one prompt, grouped by page URL with continuous
 *  numbering. Returns null when there is nothing unsent. */
export function formatNotesPrompt(notes: BrowserNote[]): string | null {
  const unsent = notes.filter(n => !n.sentAt)
  if (unsent.length === 0) return null
  const byUrl = new Map<string, BrowserNote[]>()
  for (const n of unsent) byUrl.set(n.url, [...(byUrl.get(n.url) ?? []), n])
  const blocks: string[] = []
  let i = 0
  for (const [url, group] of byUrl) {
    const lines = group.map(n => `[${++i}] ${describeLocation(n, n.target)}\n    → ${n.comment || '(no comment)'}`)
    blocks.push(`I've marked up the page ${url} with ${group.length} note${group.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`)
  }
  return blocks.join('\n\n')
}

import type { BrowserNote } from '../../domain/types'
import type { Pin } from '../../domain/pinSet'

/** Map a browser widget's legacy notes to pins. Document coords (x,y) become
 *  context.docX/docY so the browser's self-rendered markers stay glued to page
 *  content; url scopes the pin to its page; target carries DOM context. */
export function migrateBrowserNotesToPins(nodeId: string, notes: BrowserNote[] | undefined): Pin[] {
  if (!notes?.length) return []
  return notes.map(n => ({
    id: n.id,
    nodeId,
    nx: n.nx,
    ny: n.ny,
    comment: n.comment,
    createdAt: n.createdAt,
    ...(n.sentAt !== undefined ? { sentAt: n.sentAt } : {}),
    context: {
      url: n.url,
      docX: n.x,
      docY: n.y,
      ...(n.target ? { target: n.target } : {}),
    },
  }))
}

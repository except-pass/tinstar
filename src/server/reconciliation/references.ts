import { notionPageId } from './notion'

export interface CardReference {
  pageId: string
  basis: 'explicit' | 'textual'
  source: string
}

/** Extract identifiers only; never publish backlog raw text or brief contents. */
export function cardReferences(row: Record<string, unknown>, prefix: string): CardReference[] {
  const refs: CardReference[] = []
  const explicit = notionPageId(row.notion_page_id)
  if (explicit) refs.push({ pageId: explicit, basis: 'explicit', source: `${prefix}.notion_page_id` })
  for (const field of ['title', 'raw']) {
    if (typeof row[field] !== 'string') continue
    const value = row[field]
    const patterns = [
      /\bcard\s+([a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?![a-f\d-])/gi,
      /https:\/\/(?:www\.|app\.)?notion\.(?:so|com)\/[^\s<>"()]*/gi,
    ]
    for (const pattern of patterns) for (const match of value.matchAll(pattern)) {
      const candidate = match[1] ?? match[0].split('?')[0]!.match(/([a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\/?$/i)?.[1]
      const pageId = notionPageId(candidate)
      if (pageId && !refs.some(ref => ref.pageId === pageId && ref.source === `${prefix}.${field}`)) {
        refs.push({ pageId, basis: 'textual', source: `${prefix}.${field}` })
      }
    }
  }
  return refs
}

import { notionPageId } from './notion'

export interface CardReference {
  pageId: string
  basis: 'explicit' | 'textual'
  source: string
}

// One URL pattern for title/raw scans and for a work_item that is itself a Notion page URL.
const NOTION_URL = /https:\/\/(?:www\.|app\.)?notion\.(?:so|com)\/[^\s<>"()]*/gi
const PAGE_ID_AT_END = /([a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\/?$/i

function pageIdFromNotionUrl(url: string): string | null {
  return notionPageId(url.split('?')[0]!.match(PAGE_ID_AT_END)?.[1])
}

/** A work_item confirms a card only when the whole value is a page id or a Notion page URL. */
function explicitWorkItem(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const bare = notionPageId(value)
  if (bare) return bare
  const match = new RegExp(NOTION_URL.source, 'i').exec(value)
  if (!match || match.index !== 0 || match[0].length !== value.length) return null
  return pageIdFromNotionUrl(match[0])
}

/** Extract identifiers only; never publish backlog raw text or brief contents. */
export function cardReferences(row: Record<string, unknown>, prefix: string): CardReference[] {
  const refs: CardReference[] = []
  const explicit = notionPageId(row.notion_page_id)
  if (explicit) refs.push({ pageId: explicit, basis: 'explicit', source: `${prefix}.notion_page_id` })
  const workItem = explicitWorkItem(row.work_item)
  if (workItem) refs.push({ pageId: workItem, basis: 'explicit', source: `${prefix}.work_item` })
  for (const field of ['title', 'raw']) {
    if (typeof row[field] !== 'string') continue
    const value = row[field]
    const patterns = [
      /\bcard\s+([a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})(?![a-f\d-])/gi,
      new RegExp(NOTION_URL.source, NOTION_URL.flags),
    ]
    for (const pattern of patterns) for (const match of value.matchAll(pattern)) {
      const pageId = match[1] ? notionPageId(match[1]) : pageIdFromNotionUrl(match[0])
      if (pageId && !refs.some(ref => ref.pageId === pageId && ref.source === `${prefix}.${field}`)) {
        refs.push({ pageId, basis: 'textual', source: `${prefix}.${field}` })
      }
    }
  }
  return refs
}

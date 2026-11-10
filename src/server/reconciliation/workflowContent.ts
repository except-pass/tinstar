import { workflowNoteHasMarker } from '../../shared/workflowRequests'
import type { WorkReader } from './workReader'

export const richText = (content: string) => {
  const rich_text: Array<{ type: 'text'; text: { content: string } }> = []
  let chunk = ''
  for (const char of content) {
    if (chunk.length + char.length > 2000) { rich_text.push({ type: 'text', text: { content: chunk } }); chunk = '' }
    chunk += char
  }
  if (chunk) rich_text.push({ type: 'text', text: { content: chunk } })
  if (rich_text.length > 100) throw new Error('Text exceeds Notion property limits')
  return { rich_text }
}
export const paragraph = (text: string) => ({ object: 'block' as const, type: 'paragraph' as const, paragraph: richText(text) })
export const heading = (text: string) => ({ object: 'block' as const, type: 'heading_2' as const, heading_2: richText(text) })
export const codeBlock = (text: string) => ({ object: 'block' as const, type: 'code' as const, code: { ...richText(text), language: 'bash' } })
export type WorkflowCreateBlock = ReturnType<typeof paragraph> | ReturnType<typeof heading> | ReturnType<typeof codeBlock>
export const createBlockText = (block: WorkflowCreateBlock): string => plainText(block.type === 'paragraph' ? block.paragraph.rich_text : block.type === 'heading_2' ? block.heading_2.rich_text : block.code.rich_text)
export const plainText = (rich: unknown): string => Array.isArray(rich) ? rich.map(v => v?.plain_text ?? v?.text?.content ?? '').join('') : ''
export interface WorkflowNote { id: string; text: string; author?: string; createdAt?: string }
export const receiptMarker = (actor: string, operationId: string) => `Tin Star operation: ${JSON.stringify([actor, operationId])}`
export const decisionMarker = (id: string) => `Tin Star decision: ${JSON.stringify(id)}`
export const sectionMarker = (name: string) => `Tin Star section: ${name}`
export const sectionText = (name: string, text: string) => `${sectionMarker(name)}\n${name === 'brief' ? 'Brief' : 'Acceptance criteria'}\n${text}`

/** Raw internal content is used for exact write preconditions/receipts only.
 * Conversational readbacks still pass through the application's redactor. */
export class NotionWriteError extends Error { constructor(readonly status: number) { super(`Notion HTTP ${status}`) } }
export class ManagedSectionConflict extends Error {}
export class WorkflowContent {
  constructor(private reader: WorkReader) {}
  async request(path: string, method = 'GET', body?: unknown) {
    const config = this.reader.config
    if (!config) throw new Error('Notion is not configured')
    const response = await this.reader.api.fetch(`https://api.notion.com/v1/${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${config.token}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!response.ok) { await response.body?.cancel(); throw new NotionWriteError(response.status) }
    const stream = response.body?.getReader()
    if (!stream) throw new Error('Notion response missing')
    const chunks: Uint8Array[] = []; let bytes = 0
    try {
      for (;;) {
        const { done, value } = await stream.read()
        if (done) break
        bytes += value.length
        if (bytes > 4 * 1024 * 1024) throw new Error('Notion response too large')
        chunks.push(value)
      }
    } finally { await stream.cancel().catch(() => {}) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }
  async notes(id: string): Promise<WorkflowNote[]> {
    const result: WorkflowNote[] = []; let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const query = new URLSearchParams({ block_id: id, page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) })
      const body = await this.request(`comments?${query}`)
      if (!Array.isArray(body.results) || typeof body.has_more !== 'boolean') throw new Error('Incomplete comment read')
      for (const item of body.results) result.push({ id: item.id, text: plainText(item.rich_text), author: item.created_by?.id, createdAt: item.created_time })
      if (!body.has_more) return result
      if (!body.next_cursor || body.next_cursor === cursor) break
      cursor = body.next_cursor
    }
    // Incomplete reads cannot establish that a receipt/decision is absent.
    throw new Error('Comments truncated; cannot safely resolve or deduplicate this operation')
  }
  async sections(id: string, includeStructured = false) {
    const result: Array<{ id: string; text: string; type: string }> = []; let cursor: string | undefined
    for (let page = 0; page < 10; page++) {
      const query = new URLSearchParams({ page_size: '100', ...(cursor ? { start_cursor: cursor } : {}) })
      const body = await this.request(`blocks/${id}/children?${query}`)
      if (!Array.isArray(body.results) || typeof body.has_more !== 'boolean') throw new Error('Incomplete body read')
      for (const block of body.results) if ((block.type === 'paragraph' || includeStructured && ['heading_2', 'code'].includes(block.type)) && !block.archived && !block.in_trash) result.push({ id: block.id, type: block.type, text: plainText(block[block.type]?.rich_text) })
      if (!body.has_more) return result
      if (!body.next_cursor || body.next_cursor === cursor) break
      cursor = body.next_cursor
    }
    throw new Error('Body truncated; cannot safely locate the requested section')
  }
  async section(id: string, name: string, text: string, expected?: string) {
    const marker = sectionMarker(name), desired = sectionText(name, text)
    const sections = await this.sections(id), matches = sections.filter(block => block.text.split('\n')[0] === marker)
    if (matches.length > 1) throw new ManagedSectionConflict('Duplicate managed sections; correct the specific section before replacing it')
    const found = matches[0]
    if (found?.text === desired) return
    if (expected !== undefined && (found?.text ?? '') !== expected) throw new ManagedSectionConflict('Section changed; refresh before replacing it')
    if (found) await this.request(`blocks/${found.id}`, 'PATCH', { paragraph: richText(desired) })
    else await this.request(`blocks/${id}/children`, 'PATCH', { children: [paragraph(desired)] })
    const readback = await this.sections(id)
    if (readback.filter(block => block.text === desired).length !== 1) throw new Error('Section readback differs')
  }
  async note(id: string, text: string, marker: string) {
    const before = await this.notes(id)
    if (before.some(note => workflowNoteHasMarker(note, marker))) return
    await this.request('comments', 'POST', { parent: { page_id: id }, ...richText(`${text}\n${marker}`) })
    if (!(await this.notes(id)).some(note => note.text === `${text}\n${marker}`)) throw new Error('Note readback differs')
  }
}

import type { ReconciliationConfig } from './config'
import { record } from './values'

export interface CardContextRead {
  outcome: 'available' | 'partial' | 'unavailable'
  observedAt?: string
  blocks: Array<{ id: string; type: string; text: string; author?: string | null; createdAt?: string | null }>
  message?: string
  omissions?: string
}

/** Read card prose only. Code, files, embeds and unsupported blocks are not
 * exported to conversational clients. Nested/truncated context is explicit. */
export class CardContextReader {
  private comments = new Map<string, { until: number; value: Promise<CardContextRead> }>()
  private cache = new Map<string, { until: number; revision?: string; value: Promise<CardContextRead> }>()
  constructor(private config: ReconciliationConfig['notion'], private fetcher: typeof fetch = fetch) {}
  /** Comments are an existing authorized coordinator update surface as well as
   * card paragraphs. Missing comment permission leaves paragraphs readable. */
  checkpoints(id: string): Promise<CardContextRead> { return this.details(id, true) }
  invalidate(id: string) { this.cache.delete(id); this.comments.delete(id) }
  details(id: string, force = false): Promise<CardContextRead> {
    const cached = this.comments.get(id)
    if (!force && cached && cached.until > Date.now()) return cached.value
    if (force) this.invalidate(id)
    if (this.comments.size >= 100) this.comments.delete(this.comments.keys().next().value!)
    const value = this.readComments(id).catch((): CardContextRead => ({ outcome: 'unavailable', blocks: [], message: 'Card details unavailable' }))
    this.comments.set(id, { until: Date.now() + 30_000, value })
    return value
  }
  private async readComments(id: string): Promise<CardContextRead> {
    const body = await this.get(id)
    const context = { ...body, blocks: [...body.blocks] }
    if (!this.config) return context
    const signal = AbortSignal.timeout(20_000)
    let cursor: string | undefined, bytes = 0
    try {
      for (let page = 0; page < 5; page++) {
        const url = new URL('https://api.notion.com/v1/comments')
        url.searchParams.set('block_id', id); url.searchParams.set('page_size', '100')
        if (cursor) url.searchParams.set('start_cursor', cursor)
        const res = await this.fetcher(url, { signal, redirect: 'error', headers: { Authorization: `Bearer ${this.config.token}`, 'Notion-Version': '2025-09-03' } })
        if (!res.ok || !res.body) throw new Error('Comments unavailable')
        const reader = res.body.getReader(), chunks: Uint8Array[] = []
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.length
            if (bytes > 2 * 1024 * 1024) throw new Error('Comments too large')
            chunks.push(value)
          }
        } finally { await reader.cancel().catch(() => {}) }
        const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (!Array.isArray(body.results)) throw new Error('Invalid comments')
        for (const item of body.results) {
          const comment = record(item)
          if (!Array.isArray(comment.rich_text)) continue
          context.blocks.push({ id: String(comment.id), type: 'comment', author: typeof record(comment.created_by).id === 'string' ? String(record(comment.created_by).id) : null, createdAt: typeof comment.created_time === 'string' ? comment.created_time : null, text: comment.rich_text.map(v => record(v).plain_text ?? record(record(v).text).content ?? '').join('').replace(/\b(?:secret_|ntn_|sk-)[A-Za-z0-9_-]{16,}\b/g, '[credential omitted]') })
        }
        if (body.has_more !== true) return context
        const next = typeof body.next_cursor === 'string' ? body.next_cursor : undefined
        if (!next || next === cursor) throw new Error('Invalid comments cursor')
        cursor = next
      }
    } catch { /* No comment access is not evidence of closure or missing data. */ }
    return { ...context, outcome: context.outcome === 'unavailable' ? 'unavailable' : 'partial', omissions: `${context.omissions ?? ''} Comments unavailable or truncated.` }
  }
  get(id: string, revision?: string) {
    const cached = this.cache.get(id)
    if (cached && cached.until > Date.now() && (revision === undefined || revision === cached.revision)) return cached.value
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!)
    const value = this.read(id).catch((): CardContextRead => ({ outcome: 'unavailable', message: 'Card context read failed; verify configured Notion read access', blocks: [] }))
    this.cache.set(id, { until: Date.now() + 30_000, revision, value })
    return value
  }
  async read(id: string): Promise<CardContextRead> {
    if (!this.config) return { outcome: 'unavailable', message: 'Notion card context source is not configured', blocks: [] }
    const signal = AbortSignal.timeout(20_000)
    const blocks: Array<{ id: string; type: string; text: string; author?: string | null; createdAt?: string | null }> = []
    let requests = 0, bytes = 0, partial = false
    const safeTypes = new Set(['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle', 'quote', 'callout', 'table_row'])
    const visit = async (blockId: string, depth: number) => {
      let cursor: string | undefined
      do {
        if (++requests > 10 || depth > 4) { partial = true; return }
        const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`)
        url.searchParams.set('page_size', '100')
        if (cursor) url.searchParams.set('start_cursor', cursor)
        const res = await this.fetcher(url, { signal, redirect: 'error', headers: { Authorization: `Bearer ${this.config!.token}`, 'Notion-Version': '2025-09-03' } })
        if (!res.ok || !res.body) throw new Error('context unavailable')
        const reader = res.body.getReader(), chunks: Uint8Array[] = []
        try {
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            bytes += value.length
            if (bytes > 2 * 1024 * 1024) throw new Error('context too large')
            chunks.push(value)
          }
        } finally { await reader.cancel().catch(() => {}) }
        const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (!Array.isArray(body.results)) throw new Error('invalid context')
        for (const item of body.results) {
          const b = record(item), type = String(b.type), data = record(b[type])
          if (safeTypes.has(type)) {
            const rich = type === 'table_row' && Array.isArray(data.cells) ? data.cells.flat() : data.rich_text
            const text = Array.isArray(rich) ? rich.map(v => record(v).plain_text ?? record(record(v).text).content ?? '').join('') : ''
            // Avoid forwarding common credential literals embedded in prose.
            blocks.push({ id: String(b.id), type, text: text.replace(/\b(?:secret_|ntn_|sk-)[A-Za-z0-9_-]{16,}\b/g, '[credential omitted]') })
          } else partial = true
          if (b.has_children === true) {
            if (safeTypes.has(type) || type === 'table' || type === 'column_list' || type === 'column') await visit(String(b.id), depth + 1)
            else partial = true
          }
        }
        cursor = body.has_more === true && typeof body.next_cursor === 'string' ? body.next_cursor : undefined
        if (body.has_more === true && !cursor) partial = true
      } while (cursor)
    }
    await visit(id, 0)
    return { outcome: partial ? 'partial' : 'available', observedAt: new Date().toISOString(), blocks, omissions: 'Code, files, embeds and unsupported blocks omitted; bounded to ten reads and four nesting levels. This is card prose, not terminal history.' }
  }
}

import type { ReconciliationConfig } from './config'
import { record } from './values'
import { isJiraCard } from '../../shared/workIdentity'
import type { JiraAdapter } from './jira'
import { workReadback } from './workReadback'
import type { CachedDecisionHistory } from './decisionEvidence'

export const decisionHistoryDeadlineMs = 120_000
class CardHistoryReadError extends Error {}

export interface CardContextRead {
  outcome: 'available' | 'partial' | 'unavailable'
  commentsOutcome?: 'available' | 'partial' | 'unavailable'
  observedAt?: string
  blocks: Array<{ id: string; type: string; text: string; author?: string | null; authorName?: string | null; createdAt?: string | null; created_time?: string; last_edited_time?: string }>
  message?: string
  omissions?: string
}

/** Read card prose only. Code, files, embeds and unsupported blocks are not
 * exported to conversational clients. Nested/truncated context is explicit. */
export class CardContextReader {
  private decisionCache = new Map<string, { pending: boolean; value: Promise<CardContextRead>; resolved?: CachedDecisionHistory }>()
  private commentCache = new Map<string, { until: number; pending: boolean; resolvedUntil: number; value: Promise<CardContextRead>; resolved?: CardContextRead }>()
  private cache = new Map<string, { until: number; pending: boolean; resolvedUntil: number; revision?: string; value: Promise<CardContextRead>; resolved?: CardContextRead }>()
  constructor(private config: ReconciliationConfig['notion'], private fetcher: typeof fetch = fetch, private jira?: JiraAdapter) {}
  /** Comments are an existing authorized coordinator update surface as well as
   * card paragraphs. Missing comment permission leaves paragraphs readable. */
  checkpoints(id: string): Promise<CardContextRead> { return this.details(id, true) }
  invalidate(id: string) { this.cache.delete(id); this.commentCache.delete(id); this.decisionCache.delete(id) }
  /** Display cached evidence without making a property-only view wait on prose. */
  cachedComments(id: string): CardContextRead | undefined {
    const cached = this.commentCache.get(id)
    const history = this.decisionCache.get(id)?.resolved
    if (history && Date.parse(history.expires_at) > Date.now() && (!cached || Date.parse(history.expires_at) > cached.resolvedUntil)) {
      return { ...history.context, outcome: history.context.commentsOutcome ?? 'unavailable', blocks: history.context.blocks.filter(block => block.type === 'comment') }
    }
    return cached && cached.resolvedUntil > Date.now() ? cached.resolved : undefined
  }
  /** Claims can exclude a known answer even while the other history read is
   * pending. This never establishes complete history for Desk preparation. */
  cachedClaimBlocks(id: string): CardContextRead['blocks'] {
    const now = Date.now()
    const history = this.decisionCache.get(id)?.resolved
    return [...(history && Date.parse(history.expires_at) > now ? history.context.blocks : []),
      ...[this.cache.get(id), this.commentCache.get(id)].flatMap(cached =>
        cached && cached.resolvedUntil > now ? cached.resolved?.blocks ?? [] : [])]
  }
  /** Read the cached observation with its original conservative freshness;
   * looking at evidence never refreshes it or fetches source history. */
  cachedDecisionHistory(id: string) {
    const decision = this.decisionCache.get(id)?.resolved
    if (decision) return decision
    const body = this.cache.get(id), comments = this.commentCache.get(id)
    if (!body?.resolved || !comments?.resolved) return undefined
    const until = Math.min(body.resolvedUntil, comments.resolvedUntil)
    const context: CardContextRead = {
      ...body.resolved, commentsOutcome: comments.resolved.outcome,
      blocks: [...body.resolved.blocks, ...comments.resolved.blocks],
      outcome: body.resolved.outcome === 'available' && comments.resolved.outcome === 'available' ? 'available' : 'partial',
      omissions: [body.resolved.omissions, comments.resolved.omissions].filter(Boolean).join(' '),
    }
    return { context, observed_at: new Date(until - 30_000).toISOString(), expires_at: new Date(until).toISOString() }
  }
  /** WorkflowContent publishes decisions/answers as page comments and reads
   * legacy records from top-level paragraphs. Contract chunks (code), embeds,
   * and nested specification content are not workflow publication surfaces.
   * Keep this cache separate: complete decision history is not complete prose. */
  decisionDetails(id: string, force = false): Promise<CardContextRead> {
    const cached = this.decisionCache.get(id)
    if (cached && (cached.pending || !force && cached.resolved && Date.parse(cached.resolved.expires_at) > Date.now())) return cached.value
    if (this.decisionCache.size >= 100) this.decisionCache.delete(this.decisionCache.keys().next().value!)
    const observed = Date.now(), signal = AbortSignal.timeout(decisionHistoryDeadlineMs)
    const comments = this.readComments(id, signal)
    const body = this.read(id, signal).catch((error): CardContextRead => ({ outcome: 'unavailable', blocks: [],
      omissions: error instanceof CardHistoryReadError ? error.message : 'Card body history read failed.' }))
    const value = Promise.all([body, comments]).then(([body, comments]): CardContextRead => ({
      ...body, commentsOutcome: comments.outcome, blocks: [...body.blocks, ...comments.blocks],
      outcome: body.outcome === 'available' && comments.outcome === 'available' ? 'available' : 'partial',
      omissions: [body.omissions, comments.omissions].filter(Boolean).join(' '),
    }))
    const entry = { pending: true, value, resolved: cached?.resolved }
    this.decisionCache.set(id, entry)
    // Positive comment evidence remains useful to claims even if the body
    // fails. Preserve the hotfix's independent-cache behavior and freshness.
    void comments.then(result => {
      if (this.decisionCache.get(id) !== entry) return
      const until = observed + 30_000, current = this.commentCache.get(id)
      if (current?.pending || current && current.resolvedUntil > until) return
      this.commentCache.set(id, { until, pending: false, resolvedUntil: until, value: Promise.resolve(result), resolved: result })
    }).catch(() => {})
    void value.then(context => { entry.resolved = { context, observed_at: new Date(observed).toISOString(), expires_at: new Date(observed + 30_000).toISOString() } })
      .catch(() => {}).finally(() => { entry.pending = false })
    return value
  }
  details(id: string, force = false): Promise<CardContextRead> {
    if (force) this.invalidate(id)
    return Promise.all([this.get(id), this.commentDetails(id, force)]).then(([body, comments]): CardContextRead => ({
      ...body, commentsOutcome: comments.outcome, blocks: [...body.blocks, ...comments.blocks],
      outcome: body.outcome === 'unavailable' ? 'unavailable' : body.outcome === 'partial' || comments.outcome !== 'available' ? 'partial' : 'available',
      omissions: [body.omissions, comments.omissions].filter(Boolean).join(' '),
    }))
  }
  commentDetails(id: string, force = false): Promise<CardContextRead> {
    const cached = this.commentCache.get(id)
    if (!force && cached && (cached.pending || cached.until > Date.now())) return cached.value
    if (this.commentCache.size >= 100) this.commentCache.delete(this.commentCache.keys().next().value!)
    const value = this.readComments(id)
    const entry = { until: Date.now() + 30_000, pending: true, value, resolved: cached?.resolved, resolvedUntil: cached?.resolvedUntil ?? 0 }
    this.commentCache.set(id, entry)
    void value.then(result => { entry.resolved = result; entry.resolvedUntil = entry.until }).catch(() => {}).finally(() => { entry.pending = false })
    return value
  }
  private async fetchContext(url: URL, init: RequestInit, retryRateLimit: boolean) {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetcher(url, init)
      // NotionApi supplies shared Retry-After pacing. Retry only reads and
      // yield persistent throttling to the card's visible retry/backoff state.
      if (response.status !== 429 || !retryRateLimit || attempt >= 2) return response
      await response.body?.cancel()
      init.signal?.throwIfAborted()
    }
  }
  private async readComments(id: string, historySignal?: AbortSignal): Promise<CardContextRead> {
    const context: CardContextRead = { outcome: 'available', blocks: [] }
    if (isJiraCard(id)) {
      try {
        if (!this.jira) throw new Error('Jira is not configured')
        return { outcome: 'available', blocks: workReadback((await this.jira.notes(id)).map(note => ({ ...note, type: 'comment' }))) }
      } catch { return { outcome: 'partial', blocks: [], omissions: 'Jira comment history unavailable or truncated; decision and receipt absence unknown.' } }
    }
    if (!this.config) return { outcome: 'unavailable', blocks: [] }
    const signal = historySignal ?? AbortSignal.timeout(20_000)
    let failure = 'Comments unavailable or truncated.'
    let cursor: string | undefined
    const cursors = new Set<string>()
    try {
      for (let page = 0; historySignal || page < 5; page++) {
        const url = new URL('https://api.notion.com/v1/comments')
        url.searchParams.set('block_id', id); url.searchParams.set('page_size', '100')
        if (cursor) url.searchParams.set('start_cursor', cursor)
        const res = await this.fetchContext(url, { signal, redirect: 'error', headers: { Authorization: `Bearer ${this.config.token}`, 'Notion-Version': '2025-09-03' } }, !!historySignal)
        if (!res.ok || !res.body) {
          failure = `Comment history read failed (HTTP ${res.status}).`
          throw new Error('Comments unavailable')
        }
        const reader = res.body.getReader(), chunks: Uint8Array[] = []
        let bytes = 0
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
        if (!Array.isArray(body.results) || typeof body.has_more !== 'boolean') throw new Error('Invalid comments')
        for (const item of body.results) {
          const comment = record(item)
          if (!Array.isArray(comment.rich_text)) continue
          context.blocks.push({ id: String(comment.id), type: 'comment',
            authorName: typeof record(comment.created_by).name === 'string' ? String(record(comment.created_by).name) : null,
            author: typeof record(comment.created_by).id === 'string' ? String(record(comment.created_by).id) : null,
            createdAt: typeof comment.created_time === 'string' ? comment.created_time : null,
            created_time: typeof comment.created_time === 'string' ? comment.created_time : undefined,
            last_edited_time: typeof comment.last_edited_time === 'string' ? comment.last_edited_time : undefined,
            text: comment.rich_text.map(v => record(v).plain_text ?? record(record(v).text).content ?? '').join('').replace(/\b(?:secret_|ntn_|sk-)[A-Za-z0-9_-]{16,}\b/g, '[credential omitted]') })
        }
        if (body.has_more !== true) return context
        const next = typeof body.next_cursor === 'string' ? body.next_cursor : undefined
        if (!next || cursors.has(next)) throw new Error('Invalid comments cursor')
        cursors.add(next)
        cursor = next
      }
    } catch { /* No comment access is not evidence of closure or missing data. */ }
    return { ...context, outcome: 'partial', omissions: `${context.omissions ?? ''} ${failure}` }
  }
  get(id: string, revision?: string) {
    const cached = this.cache.get(id)
    if (cached && (cached.pending || cached.until > Date.now()) && (revision === undefined || revision === cached.revision)) return cached.value
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!)
    const value = this.read(id).catch((): CardContextRead => ({ outcome: 'unavailable', message: 'Card context read failed; verify configured Notion read access', blocks: [] }))
    const entry = { until: Date.now() + 30_000, pending: true, revision, value, resolved: cached?.resolved, resolvedUntil: cached?.resolvedUntil ?? 0 }
    this.cache.set(id, entry)
    void value.then(result => { entry.resolved = result; entry.resolvedUntil = entry.until }).catch(() => {}).finally(() => { entry.pending = false })
    return value
  }
  async read(id: string, historySignal?: AbortSignal): Promise<CardContextRead> {
    if (isJiraCard(id)) {
      if (!this.jira) return { outcome: 'unavailable', blocks: [], message: 'Jira is not configured' }
      return { outcome: 'available', observedAt: new Date().toISOString(), blocks: workReadback(await this.jira.sections(id)),
        omissions: 'Jira Description prose only. Exact implementation contracts in attachments are not requested; use get_work implementation_contract for verified chunks.' }
    }
    if (!this.config) return { outcome: 'unavailable', message: 'Notion card context source is not configured', blocks: [] }
    const signal = historySignal ?? AbortSignal.timeout(20_000)
    const blocks: CardContextRead['blocks'] = []
    let requests = 0, bytes = 0, partial = false
    const safeTypes = new Set(['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle', 'quote', 'callout', 'table_row'])
    const visit = async (blockId: string, depth: number) => {
      let cursor: string | undefined
      const cursors = new Set<string>()
      do {
        if (!historySignal && (++requests > 10 || depth > 4)) { partial = true; return }
        const url = new URL(`https://api.notion.com/v1/blocks/${blockId}/children`)
        url.searchParams.set('page_size', '100')
        if (cursor) url.searchParams.set('start_cursor', cursor)
        const res = await this.fetchContext(url, { signal, redirect: 'error', headers: { Authorization: `Bearer ${this.config!.token}`, 'Notion-Version': '2025-09-03' } }, !!historySignal)
        if (!res.ok || !res.body) throw new CardHistoryReadError(`Card body history read failed (HTTP ${res.status}).`)
        const reader = res.body.getReader(), chunks: Uint8Array[] = []
        if (historySignal) bytes = 0 // Limit each response, not the whole paginated history.
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
          if (b.archived === true || b.in_trash === true) continue
          if (historySignal ? type === 'paragraph' : safeTypes.has(type)) {
            const rich = type === 'table_row' && Array.isArray(data.cells) ? data.cells.flat() : data.rich_text
            const text = Array.isArray(rich) ? rich.map(v => record(v).plain_text ?? record(record(v).text).content ?? '').join('') : ''
            // Avoid forwarding common credential literals embedded in prose.
            blocks.push({ id: String(b.id), type,
              created_time: typeof b.created_time === 'string' ? b.created_time : undefined,
              last_edited_time: typeof b.last_edited_time === 'string' ? b.last_edited_time : undefined,
              text: text.replace(/\b(?:secret_|ntn_|sk-)[A-Za-z0-9_-]{16,}\b/g, '[credential omitted]') })
          } else if (!historySignal) partial = true
          if (!historySignal && b.has_children === true) {
            if (safeTypes.has(type) || type === 'table' || type === 'column_list' || type === 'column') await visit(String(b.id), depth + 1)
            else partial = true
          }
        }
        if (typeof body.has_more !== 'boolean') throw new Error('Invalid body pagination')
        cursor = body.has_more === true && typeof body.next_cursor === 'string' ? body.next_cursor : undefined
        if (body.has_more === true && (!cursor || cursors.has(cursor))) throw new Error('Invalid body cursor')
        if (cursor) cursors.add(cursor)
      } while (cursor)
    }
    await visit(id, 0)
    return { outcome: partial ? 'partial' : 'available', observedAt: new Date().toISOString(), blocks, omissions: historySignal ? 'Complete paginated workflow history from top-level paragraphs and page comments. Nested specification content, code, files and embeds are not workflow publication surfaces.' : 'Code, files, embeds and unsupported blocks omitted; bounded to ten reads and four nesting levels. This is card prose, not terminal history.' }
  }
}

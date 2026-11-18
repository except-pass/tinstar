import { readNotionCard } from './notion'
import { cachedNotionWorkflowWriter, notionWorkflowWriter, type NotionFetch } from './notionApi'
import { decisionRecordRows, decisionRequests, isDecisionRetraction, withdrawnDecisionIds, type RetractionAnswerSources } from '../../shared/workflowRequests'
import type { ReconciliationConfig } from './config'
import { record } from './values'
import { isJiraCard } from '../../shared/workIdentity'
import type { JiraAdapter } from './jira'
import { workReadback } from './workReadback'

export const decisionHistoryDeadlineMs = 120_000
class CardHistoryReadError extends Error {}

export type ClassificationExcerpt = CardContextRead | { outcome: 'provenance-rejected' }

export interface CardContextRead {
  outcome: 'available' | 'partial' | 'unavailable'
  commentsOutcome?: 'available' | 'partial' | 'unavailable'
  observedAt?: string
  blocks: Array<{ id: string; type: string; text: string; author?: string | null; authorName?: string | null; workflowWriter?: boolean; createdAt?: string | null; created_time?: string; last_edited_time?: string }>
  message?: string
  omissions?: string
}

const originalCommentText = new WeakMap<CardContextRead['blocks'][number], string>()
const unverifiedRetraction = (block: CardContextRead['blocks'][number]) => block.type === 'comment' &&
  block.workflowWriter === undefined && isDecisionRetraction(originalCommentText.get(block) ?? block.text)
export const hasUnverifiedRetractions = (context: CardContextRead) => context.blocks.some(unverifiedRetraction)
export function requestHistory(blocks: CardContextRead['blocks']) {
  return blocks.map(block => ({ ...block, text: originalCommentText.get(block) ?? block.text }))
}

/** Read card prose only. Code, files, embeds and unsupported blocks are not
 * exported to conversational clients. Nested/truncated context is explicit. */
export class CardContextReader {
  private decisionCache = new Map<string, { signal: AbortSignal; fetcher: NotionFetch; value: Promise<CardContextRead> }>()
  private commentCache = new Map<string, { until: number; pending: boolean; resolvedUntil: number; value: Promise<CardContextRead>; resolved?: CardContextRead; fetcher?: NotionFetch }>()
  private cache = new Map<string, { until: number; pending: boolean; revision?: string; value: Promise<CardContextRead>; fetcher: NotionFetch }>()
  constructor(private config: ReconciliationConfig['notion'], private fetcher: NotionFetch = fetch, private jira?: JiraAdapter) {}
  /** Comments are an existing authorized coordinator update surface as well as
   * card paragraphs. Missing comment permission leaves paragraphs readable. */
  checkpoints(id: string): Promise<CardContextRead> { return this.details(id, true) }
  invalidate(id: string) { this.cache.delete(id); this.commentCache.delete(id); this.decisionCache.delete(id) }
  /** Display cached evidence without making a property-only view wait on prose. */
  cachedComments(id: string): CardContextRead | undefined {
    const cached = this.commentCache.get(id)
    return cached && cached.resolvedUntil > Date.now() ? cached.resolved : undefined
  }
  async verifyRetractions(context: CardContextRead): Promise<CardContextRead> {
    const retractions = context.blocks.filter(unverifiedRetraction)
    if (this.config && retractions.length) {
      const writer = await notionWorkflowWriter(this.config, this.fetcher)
      for (const block of retractions) block.workflowWriter = block.author === writer
    }
    return context
  }
  async retractionAnswerSources(context: CardContextRead): Promise<RetractionAnswerSources | undefined> {
    if (!context.blocks.some(block => block.type === 'comment' && isDecisionRetraction(originalCommentText.get(block) ?? block.text))) return
    await this.verifyRetractions(context).catch(() => {})
    const history = requestHistory(context.blocks)
    const incomplete = hasUnverifiedRetractions(context) || (context.commentsOutcome ?? context.outcome) !== 'available'
    const withdrawn = withdrawnDecisionIds(history)
    const audits = new Set(history.filter(note => isDecisionRetraction(note.text)).map(note => note.id))
    const excluded = history.filter(note => audits.has(note.id) ||
      decisionRecordRows([note], 'Tin Star request: ').some(row => incomplete || withdrawn.has(row?.id))).map(note => note.id)
    const replacements = incomplete ? [] : decisionRequests(history).filter(request => !request.answered && audits.has(request.sourceId))
      .map(({ sourceId, id, question }) => ({ sourceId, id, question }))
    return { excluded, replacements }
  }
  /** Read the card text and comments used for the decision revision. */
  decisionDetails(id: string, signal = AbortSignal.timeout(decisionHistoryDeadlineMs), fetcher = this.fetcher): Promise<CardContextRead> {
    const cached = this.decisionCache.get(id)
    if (cached && !cached.signal.aborted && (fetcher === this.fetcher || fetcher === cached.fetcher)) return cached.value
    if (this.decisionCache.size >= 100) this.decisionCache.delete(this.decisionCache.keys().next().value!)
    const observed = Date.now()
    const comments = this.readComments(id, signal, fetcher)
    const body = this.read(id, signal, fetcher).catch((error): CardContextRead => ({ outcome: 'unavailable', blocks: [],
      omissions: error instanceof CardHistoryReadError ? error.message : 'Card body history read failed.' }))
    const value = Promise.all([body, comments]).then(([body, comments]): CardContextRead => ({
      ...body, commentsOutcome: comments.outcome, blocks: [...body.blocks, ...comments.blocks],
      outcome: !signal.aborted && body.outcome === 'available' && comments.outcome === 'available' ? 'available' : 'partial',
      omissions: [body.omissions, comments.omissions].filter(Boolean).join(' '),
    }))
    const entry = { signal, fetcher, value }
    this.decisionCache.set(id, entry)
    // Positive comment evidence remains useful to claims even if the body
    // fails. Preserve the hotfix's independent-cache behavior and freshness.
    void comments.then(result => {
      if (this.decisionCache.get(id) !== entry || signal.aborted && !result.blocks.length) return
      if (signal.aborted) result = { ...result, outcome: 'partial' }
      const until = observed + 30_000, current = this.commentCache.get(id)
      if (current && current.resolvedUntil > until) return
      if (current?.pending) {
        current.resolved = result
        current.resolvedUntil = until
        return
      }
      this.commentCache.set(id, { until, pending: false, resolvedUntil: until, value: Promise.resolve(result), resolved: result })
    }).catch(() => {})
    const clear = () => { if (this.decisionCache.get(id) === entry) this.decisionCache.delete(id) }
    void value.then(clear, clear)
    return value
  }
  details(id: string, force = false, fetcher = this.fetcher): Promise<CardContextRead> {
    if (force) this.invalidate(id)
    return Promise.all([this.get(id, undefined, fetcher), this.commentDetails(id, force, fetcher)]).then(([body, comments]): CardContextRead => ({
      ...body, commentsOutcome: comments.outcome, blocks: [...body.blocks, ...comments.blocks],
      outcome: body.outcome === 'unavailable' ? 'unavailable' : body.outcome === 'partial' || comments.outcome !== 'available' ? 'partial' : 'available',
      omissions: [body.omissions, comments.omissions].filter(Boolean).join(' '),
    }))
  }
  commentDetails(id: string, force = false, fetcher = this.fetcher): Promise<CardContextRead> {
    const cached = this.commentCache.get(id)
    if (!force && cached && (cached.pending ? fetcher === this.fetcher || cached.fetcher === fetcher : cached.until > Date.now())) return cached.value
    if (this.commentCache.size >= 100) this.commentCache.delete(this.commentCache.keys().next().value!)
    const value: Promise<CardContextRead> = this.readComments(id, undefined, fetcher).then(async result => {
      if (!force && cached?.pending && result.outcome !== 'available') {
        const previous = await cached.value
        if (previous.outcome === 'available') {
          entry.until = cached.until
          return previous
        }
      }
      return result
    })
    const entry = { until: Date.now() + 30_000, pending: true, value, resolved: cached?.resolved, resolvedUntil: cached?.resolvedUntil ?? 0, fetcher }
    this.commentCache.set(id, entry)
    void value.then(result => {
      if (entry.resolvedUntil > entry.until) return
      entry.resolved = result
      entry.resolvedUntil = entry.until
    }).catch(() => {}).finally(() => { entry.pending = false })
    return value
  }
  private async fetchContext(url: URL, init: RequestInit, retryRateLimit: boolean, fetcher: NotionFetch) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetcher(url, init)
      // NotionApi supplies shared Retry-After pacing. Retry only reads and
      // yield persistent throttling to the card's visible retry/backoff state.
      if (response.status !== 429 || !retryRateLimit || attempt >= 2) return response
      await response.body?.cancel()
      init.signal?.throwIfAborted()
    }
  }
  private async readComments(id: string, historySignal?: AbortSignal, fetcher = this.fetcher): Promise<CardContextRead> {
    const context: CardContextRead = { outcome: 'available', blocks: [] }
    if (isJiraCard(id)) {
      try {
        if (!this.jira) throw new Error('Jira is not configured')
        await this.jira.notes(id, historySignal, fetcher === this.fetcher, notes => {
          context.blocks.push(...workReadback(notes.map(note => ({ ...note, type: 'comment' }))))
        })
        return context
      } catch { return { ...context, outcome: 'partial', omissions: 'Jira comment history unavailable or truncated; decision and receipt absence unknown.' } }
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
        const res = await this.fetchContext(url, { signal, redirect: 'error', headers: { Authorization: `Bearer ${this.config.token}`, 'Notion-Version': '2025-09-03' } }, !!historySignal, fetcher)
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
        signal.throwIfAborted()
        const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (!Array.isArray(body.results) || typeof body.has_more !== 'boolean') throw new Error('Invalid comments')
        const writer = cachedNotionWorkflowWriter(this.config)
        for (const item of body.results) {
          const comment = record(item)
          if (!Array.isArray(comment.rich_text)) continue
          const author = record(comment.created_by).id
          const text = comment.rich_text.map(v => record(v).plain_text ?? record(record(v).text).content ?? '').join('')
          const block = { id: String(comment.id), type: 'comment',
            workflowWriter: writer && isDecisionRetraction(text) ? author === writer : undefined,
            authorName: typeof record(comment.created_by).name === 'string' ? String(record(comment.created_by).name) : null,
            author: typeof author === 'string' ? author : null,
            createdAt: typeof comment.created_time === 'string' ? comment.created_time : null,
            created_time: typeof comment.created_time === 'string' ? comment.created_time : undefined,
            last_edited_time: typeof comment.last_edited_time === 'string' ? comment.last_edited_time : undefined,
            text: text.replace(/\b(?:secret_|ntn_|sk-)[A-Za-z0-9_-]{16,}\b/g, '[credential omitted]') }
          if (text !== block.text) originalCommentText.set(block, text)
          context.blocks.push(block)
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
  get(id: string, revision?: string, fetcher = this.fetcher) {
    const cached = this.cache.get(id)
    if (cached && (cached.pending ? fetcher === this.fetcher || cached.fetcher === fetcher : cached.until > Date.now()) &&
      (revision === undefined || revision === cached.revision)) return cached.value
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!)
    const value: Promise<CardContextRead> = this.read(id, undefined, fetcher).catch((): CardContextRead => ({ outcome: 'unavailable', message: 'Card context read failed; verify configured Notion read access', blocks: [] }))
      .then(async result => {
        if (cached?.pending && (revision === undefined || revision === cached.revision) && result.outcome !== 'available') {
          const previous = await cached.value
          if (previous.outcome === 'available') {
            entry.until = cached.until
            return previous
          }
        }
        return result
      })
    const entry = { until: Date.now() + 30_000, pending: true, revision, value, fetcher }
    this.cache.set(id, entry)
    void value.finally(() => { entry.pending = false }).catch(() => {})
    return value
  }
  /** Classification uses the opening brief only and never reads comments, files or nested blocks. */
  async classificationExcerpt(id: string, expectedVersion: string): Promise<ClassificationExcerpt> {
    const excerpt = await this.read(id, undefined, this.fetcher, true)
      .catch((): CardContextRead => ({ outcome: 'unavailable', blocks: [] }))
    const card = await readNotionCard(this.config, id, this.fetcher).catch(() => undefined)
    if (!card || card.archived || card.in_trash || card.last_edited_time !== expectedVersion) {
      return { outcome: 'provenance-rejected' }
    }
    return excerpt
  }
  async read(id: string, historySignal?: AbortSignal, fetcher = this.fetcher, excerpt = false): Promise<CardContextRead> {
    if (isJiraCard(id)) {
      if (!this.jira) return { outcome: 'unavailable', blocks: [], message: 'Jira is not configured' }
      return { outcome: 'available', observedAt: new Date().toISOString(), blocks: workReadback(await this.jira.sections(id, false, historySignal, fetcher === this.fetcher)),
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
        url.searchParams.set('page_size', excerpt ? '12' : '100')
        if (cursor) url.searchParams.set('start_cursor', cursor)
        const res = await this.fetchContext(url, { signal, redirect: 'error', headers: { Authorization: `Bearer ${this.config!.token}`, 'Notion-Version': '2025-09-03' } }, !!historySignal, fetcher)
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
        signal.throwIfAborted()
        const body = record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        if (!Array.isArray(body.results)) throw new Error('invalid context')
        for (const item of body.results) {
          const b = record(item), type = String(b.type), data = record(b[type])
          if (b.archived === true || b.in_trash === true) continue
          if (safeTypes.has(type) || historySignal && type === 'code') {
            const rich = type === 'table_row' && Array.isArray(data.cells) ? data.cells.flat() : data.rich_text
            const text = Array.isArray(rich) ? rich.map(v => record(v).plain_text ?? record(record(v).text).content ?? '').join('') : ''
            // Avoid forwarding common credential literals embedded in prose.
            blocks.push({ id: String(b.id), type,
              created_time: typeof b.created_time === 'string' ? b.created_time : undefined,
              last_edited_time: typeof b.last_edited_time === 'string' ? b.last_edited_time : undefined,
              text: excerpt ? text : text.replace(/\b(?:secret_|ntn_|sk-)[A-Za-z0-9_-]{16,}\b/g, '[credential omitted]') })
          } else if (!historySignal) partial = true
          if (!excerpt && b.has_children === true) {
            if (safeTypes.has(type) || type === 'table' || type === 'column_list' || type === 'column') await visit(String(b.id), depth + 1)
            else if (!historySignal) partial = true
          }
        }
        if (typeof body.has_more !== 'boolean') throw new Error('Invalid body pagination')
        if (excerpt) return
        cursor = body.has_more === true && typeof body.next_cursor === 'string' ? body.next_cursor : undefined
        if (body.has_more === true && (!cursor || cursors.has(cursor))) throw new Error('Invalid body cursor')
        if (cursor) cursors.add(cursor)
      } while (cursor)
    }
    try { await visit(id, 0) } catch (error) {
      if (!historySignal) throw error
      return { outcome: 'partial', blocks, omissions: error instanceof CardHistoryReadError ? error.message : 'Card body history read failed.' }
    }
    return { outcome: partial && !excerpt ? 'partial' : 'available', observedAt: new Date().toISOString(), blocks, omissions: excerpt ? 'Opening top-level prose only.' : historySignal ? 'Paginated card text and page comments. Files and embeds are omitted.' : 'Code, files, embeds and unsupported blocks omitted; bounded to ten reads and four nesting levels. This is card prose, not terminal history.' }
  }
}

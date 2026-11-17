import { decisionHistoryDeadlineMs, type CardContextReader } from './cardContext'
import type { CachedDecisionHistory } from './decisionEvidence'

// Three minutes beyond the last complete horizon bridges slow reads and the
// 30s/60s retry backoff, without leaving Ready alive through a source outage.
export const decisionRenewalGraceMs = 180_000

/** One shared queue for display and admission. Two card reads at a time also
 * bound the body/comment requests waiting on the shared Notion rate limiter. */
export class PreparationHistory {
  private pending = new Map<string, { promise: Promise<void>; resolve(): void }>()
  private failures = new Map<string, { attempts: number; retryAt: number; message: string }>()
  private complete = new Map<string, CachedDecisionHistory>()
  private priority = new Set<string>()
  private queue: string[] = []
  private active = 0
  constructor(private reader: CardContextReader, private onLoaded: () => void = () => {}, private onRead: (id: string) => Promise<void> = async () => {},
    private readProperties: (id: string, signal: AbortSignal) => Promise<void> = async () => {},
    private propertiesFresh: (id: string, until: number) => boolean = () => true) {}

  warm(ids: string[], priority?: string[]) {
    if (priority) this.priority = new Set(priority)
    const important = this.priority
    for (const id of new Set([...(priority ?? []), ...ids])) {
      const history = this.reader.cachedDecisionHistory(id)
      if (this.propertiesFresh(id, Date.now() + (important.has(id) ? 15_000 : 0)) && history?.context.outcome === 'available' && history.context.commentsOutcome === 'available' && Date.parse(history.expires_at) > Date.now() + (important.has(id) ? 15_000 : 0)) continue
      if ((this.failures.get(id)?.retryAt ?? 0) > Date.now()) continue
      this.enqueue(id)
    }
    // Existing queued board reads yield to exact sources, without adding readers.
    this.queue.sort((a, b) => Number(important.has(b)) - Number(important.has(a)))
    this.drain()
  }

  async read(id: string) {
    // An explicit retry can bypass failure backoff for this card only.
    if (this.failures.has(id) && !this.pending.has(id)) {
      this.failures.delete(id)
      this.enqueue(id)
    }
    this.warm([id])
    const index = this.queue.indexOf(id)
    if (index > 0) { this.queue.splice(index, 1); this.queue.unshift(id) }
    await this.pending.get(id)?.promise
  }

  invalidate(id: string) {
    this.complete.delete(id)
    this.reader.invalidate(id)
  }

  renewalUntil(id: string) {
    const history = this.complete.get(id)
    if (!history || !this.reader.cachedDecisionHistory(id) || !this.priority.has(id) && !this.pending.has(id) && !this.failures.has(id)) return null
    const until = Date.parse(history.expires_at) + decisionRenewalGraceMs
    return until > Date.now() ? new Date(until).toISOString() : null
  }

  /** A partial read cannot prove absence. Retain the last complete history,
   * but merge positive new records so an observed answer/change still wins. */
  evidenceHistory(id: string) {
    const current = this.reader.cachedDecisionHistory(id), previous = this.complete.get(id)
    if (!current || !previous || !this.renewalUntil(id) || current.context.outcome === 'available' && current.context.commentsOutcome === 'available') return current
    const blocks = new Map(previous.context.blocks.map(block => [block.id, block]))
    for (const block of current.context.blocks) blocks.set(block.id, block)
    const retained = { ...previous, context: { ...previous.context, blocks: [...blocks.values()] } }
    this.complete.set(id, retained)
    return retained
  }

  state(id: string) {
    const history = this.reader.cachedDecisionHistory(id), failure = this.failures.get(id)
    const fresh = history && Date.parse(history.expires_at) > Date.now()
    const available = !failure && fresh && history.context.outcome === 'available' && history.context.commentsOutcome === 'available'
    return { card_id: id, state: this.pending.has(id) ? 'loading' as const : available ? 'available' as const : 'unavailable' as const,
      message: failure?.message ?? (this.pending.has(id) && this.complete.has(id) && !this.renewalUntil(id) ? 'Source renewal exceeded the last-good evidence deadline.' : null),
      retry_at: available || !failure ? null : new Date(failure.retryAt).toISOString(),
      observed_at: history?.observed_at ?? null, expires_at: history?.expires_at ?? null }
  }

  private enqueue(id: string) {
    if (this.pending.has(id)) return
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    this.pending.set(id, { promise, resolve })
    this.queue.push(id)
  }

  private async load(id: string) {
    const attempt = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // The publication reader paginates independently of bounded card prose.
      // Also settle display state if a connector fails to settle on abort.
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('History read deadline exceeded.')
          reject(error)
          attempt.abort(error)
        }, decisionHistoryDeadlineMs)
        timer.unref?.()
      })
      await Promise.race([deadline, Promise.all([this.readProperties(id, attempt.signal), this.reader.decisionDetails(id, true, attempt.signal)])])
      const history = this.reader.cachedDecisionHistory(id)
      if (history?.context.commentsOutcome !== 'available') throw new Error(`Decision comment history is incomplete. ${history?.context.omissions ?? ''}`.trim())
      if (history.context.outcome !== 'available') throw new Error(`Decision body history is incomplete. ${history.context.omissions ?? ''}`.trim())
      // A paced complete read can outlive its ordinary horizon. Preserve its
      // real start time; the bounded renewal window covers that latency too.
      this.complete.set(id, history)
      await this.onRead(id)
      this.failures.delete(id)
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'History source read failed.'
      const attempts = (this.failures.get(id)?.attempts ?? 0) + 1
      this.failures.set(id, { attempts, retryAt: Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4)),
        message: `${reason} A background retry is scheduled; Prepare now can retry this card.` })
    } finally {
      clearTimeout(timer)
      attempt.abort()
      this.evidenceHistory(id)
    }
  }

  private drain() {
    while (this.active < 2 && this.queue.length) {
      const id = this.queue.shift()!, entry = this.pending.get(id)!
      this.active++
      void this.load(id).finally(() => {
        this.active--
        this.pending.delete(id)
        entry.resolve()
        this.drain()
        this.onLoaded()
      })
    }
  }
}

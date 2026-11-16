import type { CardContextReader } from './cardContext'

/** One shared queue for display and admission. Two card reads at a time also
 * bound the body/comment requests waiting on the shared Notion rate limiter. */
export class PreparationHistory {
  private pending = new Map<string, { promise: Promise<void>; resolve(): void }>()
  private failures = new Map<string, { attempts: number; retryAt: number; message: string }>()
  private queue: string[] = []
  private active = 0
  constructor(private reader: CardContextReader, private onLoaded: () => void = () => {}) {}

  warm(ids: string[]) {
    for (const id of ids) {
      const history = this.reader.cachedDecisionHistory(id)
      if (history && Date.parse(history.expires_at) > Date.now()) continue
      if ((this.failures.get(id)?.retryAt ?? 0) > Date.now()) continue
      this.enqueue(id)
    }
    this.drain()
  }

  async read(id: string) {
    // An explicit retry can bypass failure backoff for this card only.
    if (this.failures.has(id) && !this.pending.has(id)) {
      this.failures.delete(id)
      this.reader.invalidate(id)
    }
    this.warm([id])
    const index = this.queue.indexOf(id)
    if (index > 0) { this.queue.splice(index, 1); this.queue.unshift(id) }
    await this.pending.get(id)?.promise
  }

  state(id: string) {
    const history = this.reader.cachedDecisionHistory(id), failure = this.failures.get(id)
    const fresh = history && Date.parse(history.expires_at) > Date.now()
    const available = fresh && history.context.outcome === 'available' && history.context.commentsOutcome === 'available'
    return { card_id: id, state: this.pending.has(id) ? 'loading' as const : available ? 'available' as const : 'unavailable' as const,
      message: available ? null : failure?.message ?? null,
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
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // The readers abort their HTTP work after 20 seconds. This outer deadline
      // also settles display state if a connector fails to settle on abort.
      await Promise.race([this.reader.details(id), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('History read deadline exceeded.')), 20_000)
        timer.unref?.()
      })])
      const history = this.reader.cachedDecisionHistory(id)
      if (!history || history.context.outcome !== 'available' || history.context.commentsOutcome !== 'available') throw new Error('Incomplete history')
      this.failures.delete(id)
    } catch {
      const attempts = (this.failures.get(id)?.attempts ?? 0) + 1
      this.failures.set(id, { attempts, retryAt: Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4)),
        message: 'Complete card body and comment history could not be read within the source deadline. A background retry is scheduled; Prepare now can retry this card.' })
    } finally { clearTimeout(timer) }
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

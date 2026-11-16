import type { CardContextReader } from './cardContext'

/** One shared queue for display and admission. Two card reads at a time also
 * bound the body/comment requests waiting on the shared Notion rate limiter. */
export class PreparationHistory {
  private pending = new Map<string, { promise: Promise<void>; resolve(): void }>()
  private queue: string[] = []
  private active = 0
  constructor(private reader: CardContextReader, private onLoaded: () => void = () => {}) {}

  warm(ids: string[]) {
    for (const id of ids) {
      const history = this.reader.cachedDecisionHistory(id)
      // Partial reads are reused too: a permission failure must not cause a
      // tight retry loop. Its original 30-second expiry still applies.
      if (!history || Date.parse(history.expires_at) <= Date.now()) this.enqueue(id)
    }
    this.drain()
  }

  async read(id: string) {
    this.warm([id])
    // An explicit one-card request goes ahead of queued background work,
    // sharing an existing read if it has already started.
    const index = this.queue.indexOf(id)
    if (index > 0) { this.queue.splice(index, 1); this.queue.unshift(id) }
    await this.pending.get(id)?.promise
  }

  state(id: string) {
    const history = this.reader.cachedDecisionHistory(id)
    const fresh = history && Date.parse(history.expires_at) > Date.now()
    return { card_id: id, state: this.pending.has(id) ? 'loading' as const
      : fresh && history.context.outcome === 'available' && history.context.commentsOutcome === 'available' ? 'available' as const : 'unavailable' as const,
    observed_at: history?.observed_at ?? null, expires_at: history?.expires_at ?? null }
  }

  private enqueue(id: string) {
    if (this.pending.has(id)) return
    let resolve!: () => void
    const promise = new Promise<void>(done => { resolve = done })
    this.pending.set(id, { promise, resolve })
    this.queue.push(id)
  }

  private drain() {
    while (this.active < 2 && this.queue.length) {
      const id = this.queue.shift()!, entry = this.pending.get(id)!
      this.active++
      void this.reader.details(id).catch(() => {}).finally(() => {
        this.active--
        this.pending.delete(id)
        entry.resolve()
        this.drain()
        this.onLoaded()
      })
    }
  }
}

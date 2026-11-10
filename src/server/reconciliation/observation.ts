export interface Observation<T> {
  status: 'fresh' | 'partial' | 'stale' | 'unknown'
  coverage: 'complete' | 'partial' | 'unknown'
  observedAt: string | null
  attemptedAt: string
  expiresAt: string | null
  error: string | null
  data: T | null
}

export interface ReadResult<T> { data: T; observedAt: string; coverage: 'complete' | 'partial' }

export function ageObservation<T>(value: Observation<T>, now = Date.now()): Observation<T> {
  return value.expiresAt && now >= Date.parse(value.expiresAt)
    ? { ...value, status: 'stale', coverage: 'unknown' } : value
}

/** One bounded read per TTL, including failures; concurrent clients share it. */
export class CachedObservation<T> {
  private cached: Observation<T> | null = null
  private pending: Promise<Observation<T>> | null = null
  private retryAt = 0
  private changes: Array<(data: T) => T> = []

  peek(): Observation<T> | null { return this.cached ? this.current() : null }

  isCached() { return !!this.pending || !!this.cached && this.now() < this.retryAt }

  updateData(change: (data: T) => T) {
    if (this.cached?.data) this.cached = { ...this.cached, data: change(this.cached.data) }
    if (this.pending) this.changes.push(change)
  }

  constructor(private readonly read: () => Promise<ReadResult<T>>, private readonly ttlMs: number,
    private readonly maxAgeMs: number, private readonly failureMessage: string, private readonly now = Date.now, private readonly mergePartial?: (previous: T, current: T) => T) {}

  get(force = false): Promise<Observation<T>> {
    if (this.pending) return this.pending
    if (!force && this.cached && this.now() < this.retryAt) return Promise.resolve(this.current())
    this.pending = this.refresh().finally(() => { this.pending = null })
    return this.pending
  }

  private current(): Observation<T> {
    return ageObservation(this.cached!, this.now())
  }

  private async refresh(): Promise<Observation<T>> {
    this.changes = []
    const attemptedAt = new Date(this.now()).toISOString()
    try {
      const result = await this.read()
      for (const change of this.changes) result.data = change(result.data)
      const observed = Date.parse(result.observedAt)
      if (!Number.isFinite(observed) || observed > this.now() + 60_000) throw new Error('invalid source timestamp')
      const previous = this.cached
      const merged = result.coverage === 'partial' && previous?.data != null && !!this.mergePartial
      this.cached = {
        ...result, data: merged ? this.mergePartial!(previous.data!, result.data) : result.data,
        status: merged ? 'stale' : result.coverage === 'complete' ? 'fresh' : 'partial',
        observedAt: merged ? previous.observedAt : result.observedAt,
        attemptedAt, expiresAt: merged ? previous.expiresAt : new Date(observed + this.maxAgeMs).toISOString(), error: null,
      }
    } catch {
      // Never turn a failed read into a successful empty collection, or leak
      // credential-bearing fetch/exec diagnostics into an API response.
      this.cached = {
        status: this.cached?.data ? 'stale' : 'unknown', coverage: 'unknown', attemptedAt,
        observedAt: this.cached?.observedAt ?? null, expiresAt: this.cached?.expiresAt ?? null,
        data: this.cached?.data ?? null, error: this.failureMessage,
      }
    }
    this.retryAt = this.now() + this.ttlMs
    return this.current()
  }
}

/** An incomplete publication cannot establish that an omitted record vanished. */
export function retainMissing<T>(previous: readonly T[], current: readonly T[], key: (value: T) => string): T[] {
  const published = new Set(current.map(key))
  return [...current, ...previous.filter(value => !published.has(key(value)))]
}

interface ObservationMetadata {
  status: 'fresh' | 'partial' | 'stale' | 'unknown'
  coverage: 'complete' | 'partial' | 'unknown'
  observedAt: string | null
  attemptedAt: string
  expiresAt: string | null
  error: string | null
}

export interface Observation<T> extends ObservationMetadata {
  data: T | null
  sources?: Array<ObservationMetadata & { source: string; hasMore?: boolean }>
}

export interface ReadResult<T> { data: T; observedAt: string; coverage: 'complete' | 'partial' }

export function ageObservation<T>(value: Observation<T>, now = Date.now()): Observation<T> {
  return value.expiresAt && now >= Date.parse(value.expiresAt)
    ? { ...value, status: 'stale', coverage: 'unknown' } : value
}

/** Cache bounded reads, including failures. Foreground demand can replace an
 * in-flight background observation without accepting its superseded result. */
export class CachedObservation<T> {
  private cached: Observation<T> | null = null
  private pending: { background: boolean; value: Promise<Observation<T>> } | null = null
  private retryAt = 0
  private changes: Array<(data: T) => T> = []

  peek(): Observation<T> | null { return this.cached ? this.current() : null }

  isCached() { return !!this.pending || !!this.cached && this.now() < this.retryAt }

  discard() {
    this.cached = { status: 'unknown', coverage: 'unknown', data: null, observedAt: null,
      attemptedAt: new Date(this.now()).toISOString(), expiresAt: null, error: this.failureMessage }
    this.pending = null
    this.retryAt = this.now() + this.ttlMs
    this.changes = []
  }

  updateData(change: (data: T) => T, includePending = true) {
    if (this.cached?.data) this.cached = { ...this.cached, data: change(this.cached.data) }
    if (includePending && this.pending) this.changes.push(change)
  }

  constructor(private readonly read: (background: boolean) => Promise<ReadResult<T>>, private readonly ttlMs: number,
    private readonly maxAgeMs: number, private readonly failureMessage: string, private readonly now = Date.now,
    private readonly mergePartial?: (previous: T, current: T) => T,
    private readonly acceptData?: (previous: T | null, current: T, coverage: ReadResult<T>['coverage']) => T) {}

  get(force = false, background = false): Promise<Observation<T>> {
    if (this.pending && (background || !this.pending.background)) return this.pending.value
    if (!this.pending && !force && this.cached && this.now() < this.retryAt) return Promise.resolve(this.current())
    if (!this.pending) this.changes = []
    const value: Promise<Observation<T>> = Promise.resolve().then(() => this.refresh(background, value)).finally(() => {
      if (this.pending?.value === value) this.pending = null
    })
    this.pending = { background, value }
    return value
  }

  private current(): Observation<T> {
    return ageObservation(this.cached!, this.now())
  }

  private async refresh(background: boolean, request: Promise<Observation<T>>): Promise<Observation<T>> {
    const attemptedAt = new Date(this.now()).toISOString()
    try {
      const result = await this.read(background)
      if (this.pending?.value !== request) return this.pending?.value ?? this.current()
      for (const change of this.changes) result.data = change(result.data)
      const observed = Date.parse(result.observedAt)
      if (!Number.isFinite(observed) || observed > this.now() + 60_000) throw new Error('invalid source timestamp')
      const previous = this.cached
      const merged = result.coverage === 'partial' && previous?.data != null && !!this.mergePartial
      const data = this.acceptData ? this.acceptData(previous?.data ?? null, result.data, result.coverage) : result.data
      this.cached = {
        ...result, data: merged ? this.mergePartial!(previous.data!, data) : data,
        status: merged ? 'stale' : result.coverage === 'complete' ? 'fresh' : 'partial',
        observedAt: merged ? previous.observedAt : result.observedAt,
        attemptedAt, expiresAt: merged ? previous.expiresAt : new Date(observed + this.maxAgeMs).toISOString(), error: null,
      }
    } catch {
      if (this.pending?.value !== request) return this.pending?.value ?? this.current()
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

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

  constructor(private readonly read: () => Promise<ReadResult<T>>, private readonly ttlMs: number,
    private readonly maxAgeMs: number, private readonly failureMessage: string, private readonly now = Date.now) {}

  get(): Promise<Observation<T>> {
    if (this.pending) return this.pending
    if (this.cached && this.now() < this.retryAt) return Promise.resolve(this.current())
    this.pending = this.refresh().finally(() => { this.pending = null })
    return this.pending
  }

  private current(): Observation<T> {
    return ageObservation(this.cached!, this.now())
  }

  private async refresh(): Promise<Observation<T>> {
    const attemptedAt = new Date(this.now()).toISOString()
    try {
      const result = await this.read()
      const observed = Date.parse(result.observedAt)
      if (!Number.isFinite(observed) || observed > this.now() + 60_000) throw new Error('invalid source timestamp')
      this.cached = {
        ...result, status: result.coverage === 'complete' ? 'fresh' : 'partial',
        attemptedAt, expiresAt: new Date(observed + this.maxAgeMs).toISOString(), error: null,
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

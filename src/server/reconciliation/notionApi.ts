async function waitForTurn(prior: Promise<unknown>, signal?: AbortSignal | null) {
  if (!signal) return prior
  signal.throwIfAborted()
  let abort!: () => void
  try {
    await Promise.race([prior, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
    })])
  } finally { signal.removeEventListener('abort', abort) }
}

/** All application Notion traffic shares pacing and Retry-After, including
 * forced refreshes. No automatic write retry: a lost response may have saved. */
export class NotionApi {
  readonly diagnostics = { requests: {} as Record<string, number>, cacheHits: 0, rateLimits: 0, latencyMs: 0 }
  private nextAt = 0
  private tail: Promise<unknown> = Promise.resolve()
  private schemas = new Map<string, { until: number; value: Promise<Response> }>()
  constructor(private fetcher: typeof fetch = fetch, private intervalMs = 350) {}
  /** Prose readers already bound their concurrency. Share request-start pacing
   * and 429 backoff, but do not hold property reads behind a slow history HTTP
   * response for its entire 20-second deadline. */
  readonly backgroundFetch: typeof fetch = (input, init) => this.request(input, init, true)
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET'
    const schema = method === 'GET' && /^\/v1\/data_sources\/[^/]+$/.test(url.pathname)
    const key = url.href
    const cached = schema ? this.schemas.get(key) : undefined
    if (cached && cached.until > Date.now()) { this.diagnostics.cacheHits++; return (await cached.value).clone() }
    const pending = this.request(input, init)
    if (schema) {
      const value = pending.then(response => { if (!response.ok) this.schemas.delete(key); return response.clone() }, error => { this.schemas.delete(key); throw error })
      this.schemas.set(key, { until: Date.now() + 600_000, value })
      return (await value).clone()
    }
    return pending
  }
  private async request(input: Parameters<typeof fetch>[0], init?: RequestInit, background = false) {
    const prior = this.tail
    let release!: () => void
    const slot = new Promise<void>(resolve => { release = resolve })
    // A cancelled waiter must return on its deadline, while later requests
    // still wait for the active request rather than jumping the pacing queue.
    this.tail = prior.then(() => slot)
    const started = Date.now()
    try {
      await waitForTurn(prior, init?.signal)
      while (this.nextAt > Date.now()) {
        const delay = this.nextAt - Date.now()
        await new Promise<void>((resolve, reject) => {
          const signal = init?.signal
          const abort = () => { clearTimeout(timer); reject(signal?.reason) }
          const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, delay)
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      }
      init?.signal?.throwIfAborted()
      const url = new URL(String(input)), method = init?.method ?? 'GET'
      const operation = `${method} ${url.pathname.split('/')[2] ?? 'other'}${url.pathname.endsWith('/query') ? '/query' : ''}`
      this.diagnostics.requests[operation] = (this.diagnostics.requests[operation] ?? 0) + 1
      if (background) {
        this.nextAt = Math.max(this.nextAt, Date.now() + this.intervalMs)
        release()
      }
      const response = await this.fetcher(input, init)
      if (!background) this.nextAt = Math.max(this.nextAt, Date.now() + this.intervalMs)
      if (response.status === 429) {
        this.diagnostics.rateLimits++
        const value = response.headers.get('retry-after'), seconds = Number(value)
        const until = value && Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(value ?? '')
        this.nextAt = Math.max(this.nextAt, Number.isFinite(until) ? until : Date.now() + 1000)
      }
      return response
    } finally { this.diagnostics.latencyMs += Date.now() - started; release() }
  }
}

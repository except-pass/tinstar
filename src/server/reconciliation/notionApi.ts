export type NotionFetch = (input: string | URL, init?: RequestInit, timeoutMs?: number) => Promise<Response>

const queueDeadlineMs = 30_000
export class NotionQueueTimeoutError extends DOMException {
  constructor() { super('Notion queue deadline exceeded', 'TimeoutError') }
}
type RequestJob = { start(): void }

/** All application Notion traffic shares pacing and Retry-After, including
 * forced refreshes. No automatic write retry: a lost response may have saved. */
export class NotionApi {
  readonly diagnostics = { requests: {} as Record<string, number>, cacheHits: 0, rateLimits: 0, latencyMs: 0 }
  private nextAt = 0
  private foreground: RequestJob[] = []
  private background: RequestJob[] = []
  private activeForeground = false
  private timer?: ReturnType<typeof setTimeout>
  private schemas = new Map<string, { until: number; value: Promise<Response>; background: boolean }>()
  constructor(private fetcher: typeof fetch = fetch, private intervalMs = 350) {}

  readonly backgroundFetch: NotionFetch = (input, init, timeoutMs) => this.cachedRequest(input, init, timeoutMs, true)
  readonly fetch: NotionFetch = (input, init, timeoutMs) => this.cachedRequest(input, init, timeoutMs, false)

  private async cachedRequest(input: string | URL, init: RequestInit | undefined, timeoutMs: number | undefined, background: boolean) {
    const url = new URL(input), method = (init?.method ?? 'GET').toUpperCase()
    const schema = method === 'GET' && /^\/v1\/data_sources\/[^/]+$/.test(url.pathname)
    const key = url.href
    const cached = schema ? this.schemas.get(key) : undefined
    if (cached && cached.until > Date.now() && (background || !cached.background)) {
      this.diagnostics.cacheHits++
      return (await cached.value).clone()
    }
    const pending = this.request(input, init, timeoutMs, background, url, method)
    if (!schema) return pending

    const entry = { until: Date.now() + 600_000, background, value: pending.then(response => {
      if (!response.ok) remove()
      entry.background = false
      return response.clone()
    }, error => { remove(); throw error }) }
    const remove = () => { if (this.schemas.get(key) === entry) this.schemas.delete(key) }
    this.schemas.set(key, entry)
    return (await entry.value).clone()
  }

  private dispatch() {
    clearTimeout(this.timer)
    if (this.activeForeground || !this.foreground.length && !this.background.length) return
    const delay = this.nextAt - Date.now()
    if (delay > 0) {
      this.timer = setTimeout(() => this.dispatch(), delay)
      return
    }
    ;(this.foreground.shift() ?? this.background.shift())?.start()
  }

  private request(input: string | URL, init: RequestInit | undefined, timeoutMs: number | undefined, background: boolean, url: URL, method: string) {
    const operation = `${method} ${url.pathname.split('/')[2] ?? 'other'}${url.pathname.endsWith('/query') ? '/query' : ''}`
    const started = Date.now()
    const queue = background ? this.background : this.foreground
    const callerSignal = init?.signal
    return new Promise<Response>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(queueTimer)
        callerSignal?.removeEventListener('abort', abort)
      }
      const cancel = (reason: unknown) => {
        cleanup()
        const index = queue.indexOf(job)
        if (index >= 0) {
          queue.splice(index, 1)
          this.dispatch()
        }
        this.diagnostics.latencyMs += Date.now() - started
        reject(reason)
      }
      const abort = () => cancel(callerSignal?.reason)
      const job: RequestJob = { start: () => {
        cleanup()
        this.nextAt = Date.now() + this.intervalMs
        if (!background) this.activeForeground = true
        this.diagnostics.requests[operation] = (this.diagnostics.requests[operation] ?? 0) + 1
        const deadline = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs)
        const signal = deadline && callerSignal ? AbortSignal.any([deadline, callerSignal]) : deadline ?? callerSignal
        void (async () => {
          try {
            const response = await this.fetcher(input, deadline ? { ...init, signal } : init)
            if (response.status === 429) {
              this.diagnostics.rateLimits++
              const value = response.headers.get('retry-after'), seconds = Number(value)
              const until = value && Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(value ?? '')
              this.nextAt = Math.max(this.nextAt, Number.isFinite(until) ? until : Date.now() + 1000)
            }
            resolve(response)
          } catch (error) {
            reject(error)
          } finally {
            this.diagnostics.latencyMs += Date.now() - started
            if (!background) {
              this.activeForeground = false
              this.nextAt = Math.max(this.nextAt, Date.now() + this.intervalMs)
            }
            this.dispatch()
          }
        })()
        // A pending history response must not occupy the foreground slot.
        if (background && this.intervalMs > 0) this.dispatch()
        else if (background) queueMicrotask(() => this.dispatch())
      } }
      const queueTimer = background ? undefined : setTimeout(() =>
        cancel(new NotionQueueTimeoutError()), queueDeadlineMs)
      if (callerSignal?.aborted) { abort(); return }
      callerSignal?.addEventListener('abort', abort, { once: true })
      queue.push(job)
      this.dispatch()
    })
  }
}

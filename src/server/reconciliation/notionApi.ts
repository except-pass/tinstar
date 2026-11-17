import { AsyncLocalStorage } from 'node:async_hooks'

export type NotionFetch = (input: Parameters<typeof fetch>[0], init?: RequestInit, timeoutMs?: number) => Promise<Response>
type CallerClass = 'owner' | 'mate' | 'pm-bot' | 'background' | 'other'
const callerContext = new AsyncLocalStorage<CallerClass>()
function callerClass(actor: string): CallerClass {
  switch (actor.toLowerCase()) {
    case 'owner':
    case 'owner-chatgpt': return 'owner'
    case 'mate':
    case 'firstmate':
    case 'first mate': return 'mate'
    case 'pm-bot':
    case 'pm bot': return 'pm-bot'
    default: return 'other'
  }
}
export const withNotionCaller = <T>(actor: string, run: () => T) => callerContext.run(callerClass(actor), run)
const bodyFailures = new WeakMap<Response, (error: unknown) => void>()
export const recordNotionBodyFailure = (response: Response, error: unknown) => bodyFailures.get(response)?.(error)

const queueDeadlineMs = 30_000
export class NotionQueueTimeoutError extends DOMException {
  constructor() { super('Notion queue deadline exceeded', 'TimeoutError') }
}
type RequestJob = { start(): void }

/** All application Notion traffic shares pacing and Retry-After, including
 * forced refreshes. No automatic write retry: a lost response may have saved. */
export class NotionApi {
  readonly diagnostics = { requests: {} as Record<string, number>, cacheHits: 0, rateLimits: 0, latencyMs: 0 }
  readonly callerFailures: Partial<Record<CallerClass, { timeouts: number; sourceUnavailable: number }>> = {}
  private nextAt = 0
  private foreground: RequestJob[] = []
  private background: RequestJob[] = []
  private activeForeground = false
  private timer?: ReturnType<typeof setTimeout>
  private schemas = new Map<string, { until: number; value: Promise<Response>; background: boolean }>()
  constructor(private fetcher: typeof fetch = fetch, private intervalMs = 350) {}

  readonly backgroundFetch: NotionFetch = (input, init, timeoutMs) => this.cachedRequest(input, init, timeoutMs, true)
  readonly fetch: NotionFetch = (input, init, timeoutMs) => this.cachedRequest(input, init, timeoutMs, false)

  foregroundOperation<T>(actor: string, run: () => Promise<T>) {
    if (callerContext.getStore()) return run()
    return withNotionCaller(actor, async () => {
      const result = await run()
      this.recordSourceResult(result)
      return result
    })
  }

  private count(kind: 'timeouts' | 'sourceUnavailable', caller: CallerClass) {
    const counts = this.callerFailures[caller] ??= { timeouts: 0, sourceUnavailable: 0 }
    counts[kind]++
  }

  recordSourceResult(result: unknown) {
    const caller = callerContext.getStore()
    if (!caller || !result || typeof result !== 'object') return
    const { outcome, code, recovery, context, implementation_contract } = result as {
      outcome?: string; code?: string; recovery?: { code?: string }; context?: { outcome?: string }; implementation_contract?: { code?: string }
    }
    const unavailable = [outcome, code, recovery?.code, implementation_contract?.code].some(value => typeof value === 'string' && value.endsWith('source-unavailable'))
    if (unavailable || outcome === 'stale' || outcome === 'unavailable' || context?.outcome === 'unavailable') this.count('sourceUnavailable', caller)
  }

  private async cachedRequest(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, timeoutMs: number | undefined, background: boolean) {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request?.url ?? String(input)), method = (init?.method ?? request?.method ?? 'GET').toUpperCase()
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

  private request(input: Parameters<typeof fetch>[0], init: RequestInit | undefined, timeoutMs: number | undefined, background: boolean, url: URL, method: string) {
    const operation = `${method} ${url.pathname.split('/')[2] ?? 'other'}${url.pathname.endsWith('/query') ? '/query' : ''}`
    const started = Date.now()
    const queue = background ? this.background : this.foreground
    const callerSignal = init?.signal !== undefined ? init.signal : input instanceof Request ? input.signal : undefined
    const caller = background ? 'background' : callerContext.getStore() ?? 'other'
    const countTimeout = (error: unknown) => {
      if (error instanceof Error && error.name === 'TimeoutError') this.count('timeouts', caller)
    }
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
        countTimeout(reason)
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
            if (response.body && signal) bodyFailures.set(response, error => {
              countTimeout(signal.aborted ? signal.reason : error)
              bodyFailures.delete(response)
            })
            if (response.status === 429) {
              this.diagnostics.rateLimits++
              const value = response.headers.get('retry-after'), seconds = Number(value)
              const until = value && Number.isFinite(seconds) ? Date.now() + seconds * 1000 : Date.parse(value ?? '')
              this.nextAt = Math.max(this.nextAt, Number.isFinite(until) ? until : Date.now() + 1000)
            }
            resolve(response)
          } catch (error) {
            countTimeout(signal?.aborted ? signal.reason : error)
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

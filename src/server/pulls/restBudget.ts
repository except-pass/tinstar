const hour = 3_600_000
const rateLimitMessage = 'GitHub REST rate limited'
const cacheBudget = 16 * 1024 * 1024

export interface GithubRestResponse {
  status: number
  data: unknown
  statusObserved?: false
  headers?: { etag?: string; remaining?: string; reset?: string; retryAfter?: string }
}

export function isGithubRateLimit(error: unknown): error is Error {
  return error instanceof Error && error.message === rateLimitMessage
}

function holdUntil(response: GithubRestResponse, now: number) {
  const { status, headers, data } = response
  if (status !== 403 && status !== 429) return 0
  const message = (data as { message?: unknown } | null)?.message
  const retryAfter = headers?.retryAfter
  const exhausted = headers?.remaining === '0'
  if (status === 403 && !exhausted && !retryAfter && !(typeof message === 'string' && /secondary rate limit/i.test(message))) return 0
  const retryAt = retryAfter && (/^\d+$/.test(retryAfter) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter))
  const resetAt = exhausted ? Number(headers?.reset) * 1000 : 0
  const deadline = Math.max(retryAt || 0, resetAt || 0)
  return Number.isFinite(deadline) && deadline > now ? deadline : now + 60_000
}

export class GithubRestBudget {
  private blockedUntil = 0
  private cache = new Map<string, { etag: string; data: unknown; bytes: number }>()
  private cacheBytes = 0
  private pending = new Map<string, Promise<unknown>>()
  private hourly = { requests: 0, notModified: 0, holds: 0 }
  private reporting = false

  constructor(private source: string, private now = Date.now) {}

  assertAvailable() {
    if (this.blockedUntil > this.now()) throw new Error(rateLimitMessage)
  }

  async send(send: (received: (status: number) => void) => Promise<GithubRestResponse>) {
    this.assertAvailable()
    if (!this.reporting) {
      this.reporting = true
      setInterval(() => {
        const { requests, notModified, holds } = this.hourly
        console.info(`GitHub REST hourly (${this.source}) requests=${requests} notModified=${notModified} holds=${holds}`)
        this.hourly = { requests: 0, notModified: 0, holds: 0 }
      }, hour).unref()
    }
    let observed = false
    const received = (status: number) => {
      if (observed || status < 100 || status > 599) return
      observed = true
      this.hourly.requests++
      if (status === 304) this.hourly.notModified++
    }
    const response = await send(received)
    if (response.statusObserved !== false) received(response.status)
    const now = this.now()
    const until = holdUntil(response, now)
    if (until) {
      if (this.blockedUntil <= now) this.hourly.holds++
      this.blockedUntil = Math.max(this.blockedUntil, until)
      this.assertAvailable()
    }
    return response
  }

  async get(key: string, send: (etag?: string) => Promise<GithubRestResponse>) {
    this.assertAvailable()
    const pending = this.pending.get(key)
    if (pending) return pending
    const cached = this.cache.get(key)
    const work = (async () => {
      const response = await send(cached?.etag)
      if (response.status === 304 && cached) return cached.data
      if (response.status < 200 || response.status >= 300) throw new Error(`GitHub read failed (HTTP ${response.status})`)
      if (cached) { this.cache.delete(key); this.cacheBytes -= cached.bytes }
      const etag = response.headers?.etag
      const bytes = etag ? Buffer.byteLength(JSON.stringify(response.data) ?? '') : 0
      if (etag && bytes > 0 && bytes <= cacheBudget) {
        this.cache.set(key, { etag, data: response.data, bytes })
        this.cacheBytes += bytes
        // Bound the retained response data even for full release and history pages.
        for (const [oldest, entry] of this.cache) {
          if (this.cacheBytes <= cacheBudget && this.cache.size <= 512) break
          this.cache.delete(oldest)
          this.cacheBytes -= entry.bytes
        }
      }
      return response.data
    })().finally(() => this.pending.delete(key))
    this.pending.set(key, work)
    return work
  }
}

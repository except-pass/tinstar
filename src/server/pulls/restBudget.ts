const hour = 3_600_000
const rateLimitMessage = 'GitHub REST rate limited until '
const cacheBudget = 16 * 1024 * 1024

export interface GithubRestResponse {
  status: number
  data: unknown
  headers?: { etag?: string; remaining?: string; reset?: string; retryAfter?: string }
}

export function isGithubRateLimit(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith(rateLimitMessage)
}

export const githubReadRetryDelay = (failures: number) => Math.min(30_000 * 2 ** (failures - 1), 300_000)

function holdUntil(response: GithubRestResponse, now: number) {
  const { status, headers, data } = response
  if (status !== 403 && status !== 429) return 0
  const message = (data as { message?: unknown } | null)?.message
  const retryAfter = headers?.retryAfter
  const exhausted = headers?.remaining === '0'
  if (!exhausted && !retryAfter && !(typeof message === 'string' && /secondary rate limit/i.test(message))) return 0
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
  private failures = new Map<string, { count: number; until: number; error: unknown }>()
  private requests: { at: number; notModified: boolean }[] = []

  constructor(private now = Date.now) {}

  assertAvailable() {
    if (this.blockedUntil > this.now()) throw new Error(rateLimitMessage + new Date(this.blockedUntil).toISOString())
  }

  private trimRequests() {
    const cutoff = this.now() - hour
    const expired = this.requests.findIndex(request => request.at > cutoff)
    if (expired === -1) this.requests.length = 0
    else if (expired > 0) this.requests.splice(0, expired)
  }

  stats() {
    this.trimRequests()
    return { requests: this.requests.length, notModified: this.requests.filter(request => request.notModified).length,
      blockedUntil: this.blockedUntil > this.now() ? new Date(this.blockedUntil).toISOString() : null }
  }

  async send(send: () => Promise<GithubRestResponse>) {
    this.assertAvailable()
    this.trimRequests()
    const request = { at: this.now(), notModified: false }
    this.requests.push(request)
    let response: GithubRestResponse
    try { response = await send() }
    catch (error) {
      // A missing executable cannot have sent a request.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') this.requests = this.requests.filter(entry => entry !== request)
      throw error
    }
    request.notModified = response.status === 304
    const until = holdUntil(response, this.now())
    if (until) {
      this.blockedUntil = Math.max(this.blockedUntil, until)
      this.assertAvailable()
    }
    return response
  }

  async get(key: string, send: (etag?: string) => Promise<GithubRestResponse>) {
    this.assertAvailable()
    const pending = this.pending.get(key)
    if (pending) return pending
    const failure = this.failures.get(key)
    if (failure && failure.until > this.now()) throw failure.error
    const cached = this.cache.get(key)
    const work = (async () => {
      try {
        const response = await send(cached?.etag)
        if (response.status === 304 && cached) {
          this.failures.delete(key)
          return cached.data
        }
        if (response.status < 200 || response.status >= 300) throw new Error(`GitHub read failed (HTTP ${response.status})`)
        this.failures.delete(key)
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
      } catch (error) {
        if (!isGithubRateLimit(error)) {
          const count = Math.min((failure?.count ?? 0) + 1, 5)
          this.failures.delete(key)
          this.failures.set(key, { count, until: this.now() + githubReadRetryDelay(count), error })
          if (this.failures.size > 512) this.failures.delete(this.failures.keys().next().value!)
        }
        throw error
      }
    })().finally(() => this.pending.delete(key))
    this.pending.set(key, work)
    return work
  }
}

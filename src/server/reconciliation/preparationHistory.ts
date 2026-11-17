import { decisionHistoryDeadlineMs, type CardContextReader } from './cardContext'
import type { CachedDecisionHistory } from './decisionEvidence'
import type { Observation } from './observation'

// Three minutes beyond the last complete horizon bridges slow reads and the
// 30s/60s retry backoff, without leaving Ready alive through a source outage.
export const decisionRenewalGraceMs = 180_000
export const readyCommentRefreshMs = 300_000

type BoardVersion = Pick<Observation<unknown>, 'status' | 'coverage' | 'observedAt' | 'expiresAt'> & { version: string }
type HistoryJob = { promise: Promise<void>; resolve(): void; invalidated?: boolean }
const completeHistory = (history: CachedDecisionHistory | undefined) =>
  history?.context.outcome === 'available' && history.context.commentsOutcome === 'available'

/** One shared queue for display and admission. Two card reads at a time also
 * bound the body/comment requests waiting on the shared Notion rate limiter. */
export class PreparationHistory {
  private pending = new Map<string, HistoryJob>()
  private failures = new Map<string, { attempts: number; retryAt: number; message: string }>()
  private complete = new Map<string, CachedDecisionHistory>()
  private versions = new Map<string, { version: string; lastRead: number; completeVersion?: string; commentsDirty?: boolean }>()
  private priority = new Set<string>()
  private queue: string[] = []
  private active = 0
  constructor(private reader: CardContextReader, private onLoaded: () => void = () => {}, private onRead: (id: string) => Promise<void> = async () => {},
    private readProperties: (id: string) => Promise<void> = async () => {},
    private propertiesFresh: (id: string, until: number) => boolean = () => true,
    private boardVersion: (id: string) => BoardVersion | null | undefined = () => undefined,
    private hasReadyPacket: (id: string) => boolean = () => false) {}

  warm(ids: string[], priority?: string[]) {
    if (priority) this.priority = new Set(priority)
    const important = this.priority
    for (const id of new Set([...(priority ?? []), ...ids])) {
      const board = this.boardVersion(id), version = this.versions.get(id), now = Date.now()
      // null is a configured Notion card without a current board row.
      // The next board observation can supply a version without probing prose.
      if (board === null || board && (board.status !== 'fresh' || board.coverage !== 'complete')) continue
      if (board && version?.version !== board.version) this.failures.delete(id)
      const history = this.reader.cachedDecisionHistory(id)
      const ready = !!board && version?.completeVersion === board.version && this.hasReadyPacket(id)
      if (ready && history && version &&
        !version.commentsDirty && version.lastRead + readyCommentRefreshMs > now) continue
      if ((!board || version?.completeVersion === board.version && !ready) &&
        !version?.commentsDirty && (board || this.propertiesFresh(id, now + (important.has(id) ? 15_000 : 0))) && completeHistory(history) &&
        Date.parse(history!.expires_at) > now + (important.has(id) ? 15_000 : 0)) continue
      if ((this.failures.get(id)?.retryAt ?? 0) > now) continue
      this.enqueue(id)
    }
    // Existing queued board reads yield to exact sources, without adding readers.
    this.queue.sort((a, b) => Number(important.has(b)) - Number(important.has(a)))
    this.drain()
  }

  async read(id: string) {
    // An explicit retry can bypass failure backoff for this card only.
    if (this.failures.has(id) && !this.pending.has(id)) {
      this.failures.delete(id)
    }
    this.warm([id])
    const index = this.queue.indexOf(id)
    if (index > 0) { this.queue.splice(index, 1); this.queue.unshift(id) }
    await this.pending.get(id)?.promise
  }

  invalidate(id: string, bodyChanged = true) {
    this.complete.delete(id)
    this.failures.delete(id)
    const job = this.pending.get(id)
    if (job) job.invalidated = true
    const version = this.versions.get(id)
    if (!bodyChanged && version?.completeVersion) {
      version.commentsDirty = true
      this.reader.invalidateProse(id)
    } else {
      this.versions.delete(id)
      this.reader.invalidate(id)
    }
  }

  versionChanged(id: string) {
    const board = this.boardVersion(id), previous = this.versions.get(id)?.completeVersion
    return !!(previous && board && board.version !== previous)
  }

  private historyExpiry(id: string, history: CachedDecisionHistory) {
    const board = this.boardVersion(id)
    if (!board || this.versions.get(id)?.completeVersion !== board.version) return Date.parse(history.expires_at)
    return Math.min(Date.parse(board.expiresAt ?? history.expires_at), this.hasReadyPacket(id)
      ? Date.parse(history.observed_at) + readyCommentRefreshMs : Date.parse(history.expires_at))
  }

  renewalUntil(id: string) {
    const history = this.complete.get(id)
    if (!history || !this.reader.cachedDecisionHistory(id) || !this.priority.has(id) && !this.pending.has(id) && !this.failures.has(id)) return null
    const board = this.boardVersion(id)
    // Leave room for the next scheduled comment probe after one transient
    // failure. Board freshness keeps its own, shorter outage bound.
    const until = board && this.versions.get(id)?.completeVersion === board.version
      ? Math.min(Date.parse(board.expiresAt ?? history.expires_at) + decisionRenewalGraceMs,
        this.hasReadyPacket(id) ? Date.parse(history.observed_at) + 2 * readyCommentRefreshMs + decisionRenewalGraceMs
          : Date.parse(history.expires_at) + decisionRenewalGraceMs)
      : Date.parse(history.expires_at) + decisionRenewalGraceMs
    return until > Date.now() ? new Date(until).toISOString() : null
  }

  /** A partial read cannot prove absence. Retain the last complete history,
   * but merge positive new records so an observed answer/change still wins. */
  evidenceHistory(id: string) {
    if (this.versions.get(id)?.commentsDirty) return undefined
    const current = this.reader.cachedDecisionHistory(id), previous = this.complete.get(id)
    if (current && completeHistory(current)) return { ...current, expires_at: new Date(this.historyExpiry(id, current)).toISOString() }
    if (!current || !previous || !this.renewalUntil(id)) return current
    const blocks = new Map(previous.context.blocks.map(block => [block.id, block]))
    for (const block of current.context.blocks) blocks.set(block.id, block)
    const retained = { ...previous, context: { ...previous.context, blocks: [...blocks.values()] } }
    this.complete.set(id, retained)
    return retained
  }

  state(id: string) {
    const history = this.evidenceHistory(id), failure = this.failures.get(id)
    const board = this.boardVersion(id)
    const boardUnavailable = board === null || board && (board.status !== 'fresh' || board.coverage !== 'complete')
    const fresh = history && Date.parse(history.expires_at) > Date.now()
    const available = !failure && !boardUnavailable && fresh && history.context.outcome === 'available' && history.context.commentsOutcome === 'available'
    return { card_id: id, state: this.pending.has(id) ? 'loading' as const : available ? 'available' as const : 'unavailable' as const,
      message: failure?.message ?? (boardUnavailable ? 'Canonical card property evidence is unavailable or stale.'
        : this.pending.has(id) && this.complete.has(id) && !this.renewalUntil(id) ? 'Source renewal exceeded the last-good evidence deadline.' : null),
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

  private async load(id: string, job: HistoryJob) {
    const board = this.boardVersion(id), prior = this.versions.get(id)
    if (board === null || board && (board.status !== 'fresh' || board.coverage !== 'complete')) return
    job.invalidated = false
    const version = board && { version: board.version, lastRead: Date.now(), completeVersion: prior?.completeVersion, commentsDirty: prior?.commentsDirty }
    if (version) {
      if (this.versions.size >= 100 && !prior) {
        const evict = this.versions.keys().next().value!
        this.versions.delete(evict)
        this.complete.delete(evict)
      }
      this.versions.set(id, version)
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // The publication reader paginates independently of bounded card prose.
      // Also settle display state if a connector fails to settle on abort.
      const details = board && prior?.completeVersion === board.version
        ? this.reader.decisionDetails(id, true, true) : this.reader.decisionDetails(id, true)
      await Promise.race([Promise.all([board ? undefined : this.readProperties(id), details]), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('History read deadline exceeded.')), decisionHistoryDeadlineMs)
        timer.unref?.()
      })])
      if (job.invalidated || board && this.boardVersion(id)?.version !== board.version) return
      const history = this.reader.cachedDecisionHistory(id)
      if (history?.context.commentsOutcome !== 'available') throw new Error(`Decision comment history is incomplete. ${history?.context.omissions ?? ''}`.trim())
      if (history.context.outcome !== 'available') throw new Error(`Decision body history is incomplete. ${history.context.omissions ?? ''}`.trim())
      // A paced complete read can outlive its ordinary horizon. Preserve its
      // real start time; the bounded renewal window covers that latency too.
      this.complete.set(id, history)
      if (version) {
        version.completeVersion = version.version
        version.commentsDirty = false
      }
      await this.onRead(id)
      this.failures.delete(id)
    } catch (error) {
      if (job.invalidated) return
      const reason = error instanceof Error ? error.message : 'History source read failed.'
      const attempts = (this.failures.get(id)?.attempts ?? 0) + 1
      this.failures.set(id, { attempts, retryAt: Date.now() + Math.min(300_000, 30_000 * 2 ** Math.min(attempts - 1, 4)),
        message: `${reason} A background retry is scheduled; Prepare now can retry this card.` })
    } finally {
      clearTimeout(timer)
      this.evidenceHistory(id)
    }
  }

  private drain() {
    while (this.active < 2 && this.queue.length) {
      const id = this.queue.shift()!, entry = this.pending.get(id)!
      this.active++
      void this.load(id, entry).finally(() => {
        this.active--
        this.pending.delete(id)
        entry.resolve()
        this.drain()
        this.onLoaded()
      })
    }
  }
}

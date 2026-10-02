export type QuotaLevel = 'normal' | 'low' | 'critical' | 'error'

export interface QuotaLimitingWindow {
  id: string
  label: string
  resetsAt: string | null
}

/** One quota-axi window the rail can draw. Percents are rounded. */
export interface QuotaWindowReading {
  id: string
  label: string
  startsAt?: string | null
  resetsAt: string | null
  remainingPercent: number | null
  level: QuotaLevel
}

export interface QuotaMeterProvider {
  id: string
  /** Cursor can be present before its account is signed in. */
  notSetUp?: boolean
  plan: string | null
  /** Rounded percent remaining. Null when this provider produced no reading. */
  remainingPercent: number | null
  level: QuotaLevel
  limitingWindow: QuotaLimitingWindow | null
  /** Account week. Null when quota-axi reported no weekly window. */
  weeklyWindow: QuotaWindowReading | null
  /** A measured nonweekly cycle, when the provider reports both endpoints. */
  cycleWindow?: QuotaWindowReading | null
  /** Five-hour or other session window. Null when the provider has none. */
  shortWindow: QuotaWindowReading | null
  projectedRunOutAt: string | null
  runway: 'projected_exhaustion' | 'exhausted_now' | 'through_reset' | 'unknown' | null
  error: string | null
  refreshedAt: string | null
}

export interface QuotaMeterSnapshot {
  checkedAt: string | null
  fetchedAt: string | null
  commandError: string | null
  providers: QuotaMeterProvider[]
}

export interface ParsedQuotaReport {
  fetchedAt: string | null
  providers: QuotaMeterProvider[]
}

interface RawWindow {
  id?: unknown
  label?: unknown
  kind?: unknown
  percentRemaining?: unknown
  startsAt?: unknown
  resetsAt?: unknown
}

interface RawRunway {
  status?: unknown
  projectedExhaustedAt?: unknown
  limitingWindowId?: unknown
}

interface RawScope {
  scope?: unknown
  status?: unknown
  effectivePercentRemaining?: unknown
  boundedBy?: unknown
  limitingWindowIds?: unknown
  runway?: RawRunway
}

interface RawProvider {
  provider?: unknown
  plan?: unknown
  notSetUp?: unknown
  windows?: unknown
  state?: { status?: unknown; stale?: unknown; error?: unknown; refreshedAt?: unknown }
  quotaSemantics?: { effectiveAvailability?: unknown }
}

interface NormalizedWindow {
  id: string
  label: string
  kind: string | null
  percentRemaining: number | null
  startsAt: string | null
  resetsAt: string | null
}

/** Account week ids. A model slice such as seven_day_opus must not replace these. */
const WEEKLY_WINDOW_IDS = new Set(['weekly', 'seven_day', '7d'])

/** Colour of the rail icon. Boundaries match the displayed (rounded) percent. */
export function quotaLevel(remainingPercent: number | null): QuotaLevel {
  if (remainingPercent == null) return 'error'
  if (remainingPercent < 5) return 'critical'
  if (remainingPercent < 20) return 'low'
  return 'normal'
}

/**
 * Turn one `quota-axi --json` document into the rail snapshot.
 * Unconfigured providers are omitted except Cursor, which has a visible setup state. A document without a
 * `providers` array is rejected so a bad read does not wipe a good cache.
 */
export function parseQuotaAxiReport(payload: unknown): ParsedQuotaReport {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { providers?: unknown }).providers)) {
    throw new Error('quota-axi report has no providers array')
  }
  const body = payload as { generatedAt?: unknown; providers: unknown[] }
  const fetchedAt = typeof body.generatedAt === 'string' ? body.generatedAt : null
  const rows: QuotaMeterProvider[] = []
  for (const item of body.providers) {
    const provider = readProvider(item)
    if (!provider) continue
    rows.push(provider)
    const bot = grokBotMeter(item)
    if (bot) rows.push(bot)
  }
  return { fetchedAt, providers: rows }
}

function readProvider(item: unknown): QuotaMeterProvider | null {
  if (!item || typeof item !== 'object') return null
  const raw = item as RawProvider
  if (raw.notSetUp === true && raw.provider !== 'cursor') return null
  if (typeof raw.provider !== 'string' || raw.provider.trim() === '') return null

  const windows = readWindows(raw)
  const scope = chosenScope(raw)
  const remaining = remainingPercent(scope, windows)
  const limitingWindow = limitingWindowOf(scope, windows)
  const runway = runwayOf(scope?.runway)
  const projected = runway === 'projected_exhaustion' || runway === 'exhausted_now'
    ? stringOrNull(scope?.runway?.projectedExhaustedAt)
    : null

  return {
    id: raw.provider,
    ...(raw.provider === 'cursor' && raw.notSetUp === true ? { notSetUp: true } : {}),
    plan: stringOrNull(raw.plan),
    remainingPercent: remaining,
    level: quotaLevel(remaining),
    limitingWindow,
    // Cursor's Grok Bot week is its own meter, below, not Cursor's main usage quota.
    weeklyWindow: raw.provider === 'cursor' ? null : toReading(pickWeekly(windows)),
    ...(raw.provider === 'cursor' ? { cycleWindow: toReading(pickCycle(scopedWindows(scope, windows))) } : {}),
    shortWindow: toReading(pickShort(windows)),
    projectedRunOutAt: projected,
    runway,
    error: providerError(raw, remaining),
    refreshedAt: stringOrNull(raw.state?.refreshedAt),
  }
}

/** Cursor reports Grok Bot as its own weekly window, separate from included usage. */
function grokBotMeter(item: unknown): QuotaMeterProvider | null {
  if (!item || typeof item !== 'object') return null
  const raw = item as RawProvider
  if (raw.provider !== 'cursor') return null
  const reading = toReading(readWindows(raw).find(window => window.id === 'grok_bot') ?? null)
  if (!reading) return null
  return {
    id: 'grok_bot',
    plan: null,
    remainingPercent: reading.remainingPercent,
    level: reading.level,
    limitingWindow: { id: reading.id, label: 'Grok Bot', resetsAt: reading.resetsAt },
    weeklyWindow: { ...reading, label: 'Grok Bot' },
    shortWindow: null,
    projectedRunOutAt: null,
    runway: null,
    error: null,
    refreshedAt: stringOrNull(raw.state?.refreshedAt),
  }
}

function readWindows(raw: RawProvider): NormalizedWindow[] {
  if (!Array.isArray(raw.windows)) return []
  const windows: NormalizedWindow[] = []
  for (const item of raw.windows) {
    if (!item || typeof item !== 'object') continue
    const window = item as RawWindow
    if (typeof window.id !== 'string' || window.id === '') continue
    windows.push({
      id: window.id,
      label: typeof window.label === 'string' && window.label ? window.label : window.id,
      kind: typeof window.kind === 'string' && window.kind ? window.kind : null,
      percentRemaining: finite(window.percentRemaining),
      startsAt: stringOrNull(window.startsAt),
      resetsAt: stringOrNull(window.resetsAt),
    })
  }
  return windows
}

function chosenScope(raw: RawProvider): RawScope | null {
  const list = raw.quotaSemantics?.effectiveAvailability
  if (!Array.isArray(list)) return null
  const known = list.filter((item): item is RawScope => {
    if (!item || typeof item !== 'object') return false
    const scope = item as RawScope
    return scope.status === 'known' && finite(scope.effectivePercentRemaining) != null
  })
  return known.find(scope => scope.scope === 'all_models') ?? known[0] ?? null
}

function remainingPercent(scope: RawScope | null, windows: NormalizedWindow[]): number | null {
  const effective = finite(scope?.effectivePercentRemaining)
  if (effective != null) return Math.round(effective)
  const values = windows.map(window => window.percentRemaining).filter((value): value is number => value != null)
  if (values.length === 0) return null
  return Math.round(Math.min(...values))
}

function toReading(window: NormalizedWindow | null): QuotaWindowReading | null {
  if (!window) return null
  const remaining = window.percentRemaining == null ? null : Math.round(window.percentRemaining)
  return {
    id: window.id,
    label: window.label,
    startsAt: window.startsAt,
    resetsAt: window.resetsAt,
    remainingPercent: remaining,
    level: quotaLevel(remaining),
  }
}

function pickTightest(windows: NormalizedWindow[]): NormalizedWindow | null {
  if (windows.length === 0) return null
  return windows.reduce((best, window) => {
    if (best.percentRemaining == null) return window.percentRemaining == null ? best : window
    if (window.percentRemaining == null) return best
    return window.percentRemaining < best.percentRemaining ? window : best
  })
}

function isWeekly(window: NormalizedWindow): boolean {
  return window.kind === 'weekly' || WEEKLY_WINDOW_IDS.has(window.id) || /seven_day|weekly/.test(window.id)
}

function pickWeekly(windows: NormalizedWindow[]): NormalizedWindow | null {
  const weekly = windows.filter(isWeekly)
  // A product or model slice (id contains ':') must not replace the account week.
  const account = weekly.filter(window => WEEKLY_WINDOW_IDS.has(window.id) || !window.id.includes(':'))
  const named = account.filter(window => WEEKLY_WINDOW_IDS.has(window.id))
  return pickTightest(named.length > 0 ? named : account.length > 0 ? account : weekly)
}

function scopedWindows(scope: RawScope | null, windows: NormalizedWindow[]): NormalizedWindow[] {
  const ids = Array.isArray(scope?.boundedBy) ? scope.boundedBy.filter((id): id is string => typeof id === 'string') : []
  return ids.length > 0 ? windows.filter(window => ids.includes(window.id)) : windows
}

function pickCycle(windows: NormalizedWindow[]): NormalizedWindow | null {
  return pickTightest(windows.filter(window => !isWeekly(window) && window.startsAt && window.resetsAt))
}

function pickShort(windows: NormalizedWindow[]): NormalizedWindow | null {
  return pickTightest(windows.filter(window => window.kind === 'session' || window.id === 'five_hour' || window.id === 'session'))
}

function limitingWindowOf(scope: RawScope | null, windows: NormalizedWindow[]): QuotaLimitingWindow | null {
  const listed = Array.isArray(scope?.limitingWindowIds)
    ? scope.limitingWindowIds.find((id): id is string => typeof id === 'string' && id !== '')
    : undefined
  const id = listed ?? stringOrNull(scope?.runway?.limitingWindowId)
  if (id) {
    const found = windows.find(window => window.id === id)
    return found
      ? { id: found.id, label: found.label, resetsAt: found.resetsAt }
      : { id, label: id, resetsAt: null }
  }
  const measured = windows.filter(window => window.percentRemaining != null)
  if (measured.length === 0) return null
  const tightest = measured.reduce((best, window) => window.percentRemaining! < best.percentRemaining! ? window : best)
  return { id: tightest.id, label: tightest.label, resetsAt: tightest.resetsAt }
}

function runwayOf(runway: RawRunway | undefined): QuotaMeterProvider['runway'] {
  const status = runway?.status
  if (status === 'projected_exhaustion' || status === 'exhausted_now' || status === 'through_reset' || status === 'unknown') {
    return status
  }
  return null
}

function providerError(raw: RawProvider, remaining: number | null): string | null {
  const explicit = stringOrNull(raw.state?.error)
  if (explicit) return explicit
  const status = raw.state?.status
  if (status === 'auth_required') return 'sign-in required'
  if (status === 'rate_limited') return 'rate limited'
  if (remaining == null && status && status !== 'fresh') return 'no reading'
  if (raw.state?.stale === true || status === 'stale') return 'stale reading'
  return null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

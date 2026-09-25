export type ClaudeBucketView =
  | { kind: 'not-configured' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; remaining: number; resetsAt: string }

export type ClaudeView =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'not-configured'; fixture: boolean }
  | {
      kind: 'ready'
      fixture: boolean
      fetchedAt: string
      fiveHour: ClaudeBucketView
      sevenDay: ClaudeBucketView
      error: string | null
    }

export interface AxiScopeView {
  scope: string
  status: 'known' | 'unknown'
  percentRemaining: number | null
  unit: 'percent-remaining' | null
  runway: string | null
  resetsAt: string | null
}

export interface AxiAccountView {
  provider: string
  accountKey: string | null
  semantics: string
  freshness: string
  scopes: AxiScopeView[]
}

export type AxiView =
  | { kind: 'loading' }
  | { kind: 'unavailable'; fixture: boolean }
  | {
      kind: 'ready'
      fixture: boolean
      schemaVersion: 5 | 6
      generatedAt: string | null
      accounts: AxiAccountView[]
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function parseClaudeQuota(body: unknown): ClaudeView {
  if (!isRecord(body)) return { kind: 'unavailable' }
  const fixture = body.fixture === true
  if (body.error && (body.data === null || body.data === undefined)) {
    return { kind: 'unavailable' }
  }
  if (body.data === null || body.data === undefined) {
    return { kind: 'not-configured', fixture }
  }
  if (!isRecord(body.data)) return { kind: 'unavailable' }
  const error = isRecord(body.error) && typeof body.error.message === 'string'
    ? body.error.message
    : null
  return {
    kind: 'ready',
    fixture,
    fetchedAt: typeof body.fetchedAt === 'string' ? body.fetchedAt : '',
    fiveHour: parseBucket(body.data.five_hour),
    sevenDay: parseBucket(body.data.seven_day),
    error,
  }
}

function parseBucket(raw: unknown): ClaudeBucketView {
  if (raw === null || raw === undefined) return { kind: 'not-configured' }
  if (!isRecord(raw)) return { kind: 'unavailable' }
  const utilization = raw.utilization
  const resetsAt = raw.resets_at
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) {
    return { kind: 'unavailable' }
  }
  if (utilization < 0 || utilization > 100) return { kind: 'unavailable' }
  if (typeof resetsAt !== 'string' || Number.isNaN(Date.parse(resetsAt))) {
    return { kind: 'unavailable' }
  }
  return {
    kind: 'ready',
    remaining: Math.round(100 - utilization),
    resetsAt,
  }
}

export function parseAxiQuota(body: unknown): AxiView {
  if (!isRecord(body) || body.ok !== true || !isRecord(body.data)) {
    return { kind: 'unavailable', fixture: false }
  }
  const data = body.data
  const fixture = data.fixture === true
  if (data.schema !== 'tinstar.v6.quota/1' || !isRecord(data.axi)) {
    return { kind: 'unavailable', fixture }
  }
  const axi = data.axi
  if (axi.state === 'unavailable') return { kind: 'unavailable', fixture }
  if (axi.state !== 'available') return { kind: 'unavailable', fixture }
  if (axi.schemaVersion !== 5 && axi.schemaVersion !== 6) {
    return { kind: 'unavailable', fixture }
  }
  if (!Array.isArray(axi.accounts)) return { kind: 'unavailable', fixture }
  const accounts: AxiAccountView[] = []
  for (const row of axi.accounts) {
    const account = parseAccount(row)
    if (!account) return { kind: 'unavailable', fixture }
    accounts.push(account)
  }
  return {
    kind: 'ready',
    fixture,
    schemaVersion: axi.schemaVersion,
    generatedAt: typeof axi.generatedAt === 'string' ? axi.generatedAt : null,
    accounts,
  }
}

function parseAccount(raw: unknown): AxiAccountView | null {
  if (!isRecord(raw)) return null
  if (typeof raw.provider !== 'string' || raw.provider.length === 0) return null
  if (raw.accountKey !== null && typeof raw.accountKey !== 'string') return null
  if (typeof raw.semantics !== 'string' || typeof raw.freshness !== 'string') return null
  if (!Array.isArray(raw.scopes)) return null
  const scopes: AxiScopeView[] = []
  for (const scope of raw.scopes) {
    const parsed = parseScope(scope)
    if (!parsed) return null
    scopes.push(parsed)
  }
  return {
    provider: raw.provider,
    accountKey: raw.accountKey ?? null,
    semantics: raw.semantics,
    freshness: raw.freshness,
    scopes,
  }
}

function parseScope(raw: unknown): AxiScopeView | null {
  if (!isRecord(raw)) return null
  if (typeof raw.scope !== 'string' || raw.scope.length === 0) return null
  if (raw.status !== 'known' && raw.status !== 'unknown') return null
  const unit = raw.unit === 'percent-remaining' ? 'percent-remaining' : null
  const percent = raw.percentRemaining
  if (percent !== null && (typeof percent !== 'number' || !Number.isFinite(percent))) return null
  if (typeof percent === 'number' && (percent < 0 || percent > 100)) return null
  if (raw.status === 'unknown' && percent !== null) return null
  if (raw.status === 'known' && unit !== 'percent-remaining') return null
  return {
    scope: raw.scope,
    status: raw.status,
    percentRemaining: typeof percent === 'number' ? percent : null,
    unit: raw.status === 'known' ? unit : null,
    runway: typeof raw.runway === 'string' ? raw.runway : null,
    resetsAt: typeof raw.resetsAt === 'string' ? raw.resetsAt : null,
  }
}

export function humanDuration(ms: number): string {
  if (ms <= 0) return 'now'
  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor((ms % 86_400_000) / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function freshnessLabel(iso: string, nowMs: number): string {
  const then = Date.parse(iso)
  if (!iso || Number.isNaN(then) || then <= 0) return 'freshness unknown'
  const minutes = Math.max(0, Math.floor((nowMs - then) / 60_000))
  if (minutes < 1) return 'updated just now'
  if (minutes < 60) return `updated ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `updated ${hours}h ago`
  return `updated ${Math.floor(hours / 24)}d ago`
}

export function resetLabel(iso: string, nowMs: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'reset unknown'
  return `resets ${humanDuration(then - nowMs)}`
}

export function formatPercentRemaining(value: number): string {
  if (Number.isInteger(value)) return `${value}% remaining`
  const rounded = Math.round(value * 10) / 10
  return `${rounded}% remaining`
}

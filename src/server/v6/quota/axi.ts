import { execFile, type ExecFileException } from 'node:child_process'

/** Fixed command. No request field is concatenated onto this. */
export const QUOTA_AXI_COMMAND = 'quota-axi'
/** Fixed argv. The only accepted invocation is `quota-axi --json`. */
export const QUOTA_AXI_ARGS = Object.freeze(['--json'])
export const QUOTA_AXI_TIMEOUT_MS = 5_000
export const QUOTA_AXI_MAX_BUFFER = 2_000_000

const PROVIDER_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/
const RUNWAY_KNOWN = new Set([
  'through_reset',
  'projected_exhaustion',
  'exhausted_now',
  'unknown',
])
const RUNWAY_UNKNOWN = new Set(['unknown', 'exhausted_now'])

export interface QuotaAxiExecution {
  missing: boolean
  exitCode: number | null
  stdout: string
}

export interface AxiScope {
  scope: string
  status: 'known' | 'unknown'
  /** Usage-window percent remaining. Null when the snapshot omits the field. */
  percentRemaining: number | null
  unit: 'percent-remaining' | null
  runway: string | null
  resetsAt: string | null
}

export interface AxiAccount {
  provider: string
  /** Null on schema 5, which has one row per provider and no account key. */
  accountKey: string | null
  semantics: 'known' | 'partial' | 'unknown'
  freshness: string
  scopes: AxiScope[]
}

export type AxiSnapshot =
  | {
      state: 'available'
      schemaVersion: 5 | 6
      fixture: boolean
      generatedAt: string | null
      accounts: AxiAccount[]
    }
  | {
      state: 'unavailable'
      reason: 'missing' | 'exit' | 'schema' | 'malformed'
      fixture: boolean
    }

interface ExecOptions {
  timeout: number
  shell: false
  maxBuffer: number
  windowsHide: true
  encoding: 'utf8'
}

type ExecImpl = (
  file: string,
  args: readonly string[],
  options: ExecOptions,
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => void

interface WindowRef {
  id: string
  resetsAt: string | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function unavailable(
  reason: 'missing' | 'exit' | 'schema' | 'malformed',
  fixture = false,
): AxiSnapshot {
  return { state: 'unavailable', reason, fixture }
}

export function executeQuotaAxi(execImpl: ExecImpl = execFile as ExecImpl): Promise<QuotaAxiExecution> {
  return new Promise((resolve) => {
    execImpl(
      QUOTA_AXI_COMMAND,
      [...QUOTA_AXI_ARGS],
      {
        timeout: QUOTA_AXI_TIMEOUT_MS,
        shell: false,
        maxBuffer: QUOTA_AXI_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout) => {
        resolve(classifyExecution(error, stdout))
      },
    )
  })
}

function classifyExecution(error: ExecFileException | null, stdout: string): QuotaAxiExecution {
  if (!error) return { missing: false, exitCode: 0, stdout: stdout ?? '' }
  if (error.code === 'ENOENT') return { missing: true, exitCode: null, stdout: '' }
  if (typeof error.code === 'number') return { missing: false, exitCode: error.code, stdout: '' }
  return { missing: false, exitCode: null, stdout: '' }
}

export function interpretQuotaAxi(result: QuotaAxiExecution): AxiSnapshot {
  if (result.missing) return unavailable('missing')
  if (result.exitCode !== 0) return unavailable('exit')
  let raw: unknown
  try {
    raw = JSON.parse(result.stdout)
  } catch {
    return unavailable('malformed')
  }
  return parseQuotaAxiSnapshot(raw)
}

export function parseQuotaAxiSnapshot(raw: unknown): AxiSnapshot {
  if (!isRecord(raw)) return unavailable('malformed')
  const fixture = raw.fixture === true
  if (raw.schemaVersion !== 5 && raw.schemaVersion !== 6) return unavailable('schema', fixture)
  if (!Array.isArray(raw.providers)) return unavailable('schema', fixture)
  const schemaVersion = raw.schemaVersion
  const accounts: AxiAccount[] = []
  const seen = new Set<string>()
  for (const row of raw.providers) {
    const account = parseAccount(row, schemaVersion)
    if (!account) return unavailable('schema', fixture)
    const identity = schemaVersion === 6
      ? `${account.provider}\0${account.accountKey}`
      : account.provider
    if (seen.has(identity)) return unavailable('schema', fixture)
    seen.add(identity)
    accounts.push(account)
  }
  return {
    state: 'available',
    schemaVersion,
    fixture,
    generatedAt: typeof raw.generatedAt === 'string' && raw.generatedAt.length > 0
      ? raw.generatedAt
      : null,
    accounts,
  }
}

function parseAccount(row: unknown, schemaVersion: 5 | 6): AxiAccount | null {
  if (!isRecord(row)) return null
  if (typeof row.provider !== 'string' || !PROVIDER_ID.test(row.provider)) return null
  let accountKey: string | null = null
  if (schemaVersion === 6) {
    if (!validAccountKey(row.accountKey)) return null
    accountKey = row.accountKey
  }
  const semantics = parseSemantics(row.quotaSemantics, windowsOn(row))
  if (!semantics) return null
  return {
    provider: row.provider,
    accountKey,
    semantics: semantics.status,
    freshness: freshnessOf(row.state),
    scopes: semantics.scopes,
  }
}

function validAccountKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !/\s/.test(value)
}

function freshnessOf(state: unknown): string {
  if (!isRecord(state)) return 'unknown'
  const status = typeof state.status === 'string' && state.status.length > 0
    ? state.status
    : null
  if (state.stale === true) return status ? `stale · ${status}` : 'stale'
  return status ?? 'unknown'
}

function windowsOn(row: Record<string, unknown>): WindowRef[] {
  if (!Array.isArray(row.windows)) return []
  const windows: WindowRef[] = []
  for (const entry of row.windows) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue
    const resetsAt = typeof entry.resetsAt === 'string' && !Number.isNaN(Date.parse(entry.resetsAt))
      ? entry.resetsAt
      : null
    windows.push({ id: entry.id, resetsAt })
  }
  return windows
}

function parseSemantics(
  raw: unknown,
  windows: WindowRef[],
): { status: 'known' | 'partial' | 'unknown'; scopes: AxiScope[] } | null {
  if (!isRecord(raw)) return null
  const status = raw.status
  if (status !== 'known' && status !== 'partial' && status !== 'unknown') return null
  if (!Array.isArray(raw.effectiveAvailability)) return null
  if (status === 'known' && raw.effectiveAvailability.length === 0) return null
  const scopes: AxiScope[] = []
  for (const entry of raw.effectiveAvailability) {
    const scope = parseScope(entry, windows)
    if (!scope) return null
    if (status === 'unknown' && scope.status !== 'unknown') return null
    scopes.push(scope)
  }
  return { status, scopes }
}

function parseScope(raw: unknown, windows: WindowRef[]): AxiScope | null {
  if (!isRecord(raw)) return null
  if (typeof raw.scope !== 'string' || raw.scope.length === 0) return null
  if (/^\s|\s$/.test(raw.scope)) return null
  if (raw.status !== 'known' && raw.status !== 'unknown') return null
  if (raw.status === 'known') {
    const percent = raw.effectivePercentRemaining
    if (typeof percent !== 'number' || !Number.isFinite(percent)) return null
    if (percent < 0 || percent > 100) return null
    if (!isRecord(raw.runway) || typeof raw.runway.status !== 'string') return null
    if (!RUNWAY_KNOWN.has(raw.runway.status)) return null
    return {
      scope: raw.scope,
      status: 'known',
      percentRemaining: percent,
      unit: 'percent-remaining',
      runway: raw.runway.status,
      resetsAt: resetsAtOf(raw, windows),
    }
  }
  if ('effectivePercentRemaining' in raw) return null
  if ('runway' in raw) {
    if (!isRecord(raw.runway) || typeof raw.runway.status !== 'string') return null
    if (!RUNWAY_UNKNOWN.has(raw.runway.status)) return null
    return {
      scope: raw.scope,
      status: 'unknown',
      percentRemaining: null,
      unit: null,
      runway: raw.runway.status,
      resetsAt: null,
    }
  }
  return {
    scope: raw.scope,
    status: 'unknown',
    percentRemaining: null,
    unit: null,
    runway: null,
    resetsAt: null,
  }
}

function resetsAtOf(scope: Record<string, unknown>, windows: WindowRef[]): string | null {
  if (typeof scope.resetsAt === 'string' && !Number.isNaN(Date.parse(scope.resetsAt))) {
    return scope.resetsAt
  }
  if (!Array.isArray(scope.limitingWindowIds)) return null
  for (const id of scope.limitingWindowIds) {
    if (typeof id !== 'string') continue
    const match = windows.find((window) => window.id === id)
    if (match?.resetsAt) return match.resetsAt
  }
  return null
}

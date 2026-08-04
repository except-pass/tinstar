import { createServer, type Server } from 'node:http'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ProviderTokenUsage } from '../../domain/provider-capabilities.js'
import type {
  ProviderObservationIngestor,
  ProviderObservationMetricSink,
} from '../providers/observation-ingestor.js'
import { log } from '../logger.js'
import { CODEX_OTEL_LOGS_PORT } from './ports.js'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const MAX_SEEN_EVENTS = 8_192
const CODEX_OTEL_SOURCE = { id: 'codex-otel', label: 'Codex OpenTelemetry' }

interface CodexSessionTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total: number
  activeSeconds: number
  model?: string
  updatedAt: string
}

interface PersistedCodexTelemetry {
  version: 1
  sessions: Record<string, CodexSessionTotals>
}

export interface CodexOtelReceiverOptions {
  ingestor: ProviderObservationIngestor
  metricSink: ProviderObservationMetricSink
  statePath?: string | null
  port?: number
}

/**
 * Loopback OTLP/HTTP JSON receiver for Codex.
 *
 * Codex emits token counts and request durations as structured log events, not
 * as the Claude metric names the dashboard historically queried. This receiver
 * normalizes those provider-native names immediately. Raw log bodies, prompts,
 * and tool output are never retained.
 */
export class CodexOtelReceiver {
  private readonly ingestor: ProviderObservationIngestor
  private readonly metricSink: ProviderObservationMetricSink
  private readonly statePath: string | null
  private readonly port: number
  private readonly totals = new Map<string, CodexSessionTotals>()
  private readonly seen = new Set<string>()
  private server: Server | null = null

  constructor(options: CodexOtelReceiverOptions) {
    this.ingestor = options.ingestor
    this.metricSink = options.metricSink
    this.statePath = options.statePath === undefined ? null : options.statePath
    this.port = options.port ?? CODEX_OTEL_LOGS_PORT
    this.loadState()
  }

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => {
      const match = req.url?.match(/^\/v1\/logs\/([^/?]+)(?:\?.*)?$/u)
      if (req.method !== 'POST' || !match) {
        res.writeHead(404).end()
        return
      }
      let sessionName: string
      try {
        sessionName = decodeURIComponent(match[1] ?? '')
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'invalid session encoding' }))
        return
      }
      readJsonBody(req, MAX_BODY_BYTES)
        .then(payload => {
          this.ingestPayload(sessionName, payload)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        })
        .catch(error => {
          const tooLarge = error instanceof BodyTooLargeError
          res.writeHead(tooLarge ? 413 : 400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: tooLarge ? 'payload too large' : 'invalid OTLP JSON' }))
        })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    server.unref()
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  /** Testable normalization boundary for an already-decoded OTLP JSON payload. */
  ingestPayload(sessionName: string, payload: unknown): number {
    if (!sessionName.trim()) return 0
    const records = logRecords(payload)
    let accepted = 0
    for (const record of records) {
      const event = normalizedEvent(record)
      if (!event) continue
      const eventId = JSON.stringify([
        sessionName,
        event.at,
        event.name,
        event.kind,
        event.totalTokens,
        event.durationMs,
        event.model,
      ])
      if (this.seen.has(eventId)) continue
      this.remember(eventId)

      if (event.name === 'codex.sse_event' && event.kind === 'response.completed') {
        this.recordUsage(sessionName, event)
        accepted += 1
      } else if (ACTIVE_EVENT_NAMES.has(event.name) && event.durationMs !== null) {
        this.recordActiveTime(sessionName, event)
        accepted += 1
      }
    }
    if (accepted > 0) this.persistState()
    return accepted
  }

  private recordUsage(sessionName: string, event: NormalizedCodexEvent): void {
    const current = this.current(sessionName, event.at)
    const initializeCounter = current.total === 0
      && current.input === 0
      && current.output === 0
    const input = event.inputTokens ?? 0
    const output = event.outputTokens ?? 0
    const total = event.totalTokens ?? input + output
    current.input += input
    current.output += output
    current.cacheRead += event.cachedTokens ?? 0
    current.cacheWrite += event.cacheWriteTokens ?? 0
    current.reasoning += event.reasoningTokens ?? 0
    current.total += total
    current.updatedAt = event.at
    if (event.model) current.model = event.model

    const cumulativeTokens = tokenBag(current)
    const latestTurnTokens = tokenBag({
      input,
      output,
      cacheRead: event.cachedTokens ?? 0,
      cacheWrite: event.cacheWriteTokens ?? 0,
      reasoning: event.reasoningTokens ?? 0,
      total,
    })
    this.ingestor.ingest({
      providerId: 'codex',
      sessionId: sessionName,
      accountRef: 'default',
      source: CODEX_OTEL_SOURCE,
      event: {
        id: `otel:${event.at}:${input}:${output}:${total}`,
        observedAt: event.at,
        replayed: false,
        sessionUsage: {
          ...(current.model ? { model: current.model } : {}),
          cumulativeTokens,
          latestTurnTokens,
        },
      },
    })
    if (initializeCounter) {
      this.emitTokenCounters(
        sessionName,
        { ...current, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 },
        justBefore(event.at),
      )
    }
    this.emitTokenCounters(sessionName, current, event.at)
  }

  private recordActiveTime(sessionName: string, event: NormalizedCodexEvent): void {
    const current = this.current(sessionName, event.at)
    const initializeCounter = current.activeSeconds === 0
    current.activeSeconds += Math.max(0, event.durationMs ?? 0) / 1_000
    current.updatedAt = event.at
    if (initializeCounter) {
      this.metricSink.pushMetric({
        name: 'tinstar_provider_session_active_time_seconds_total',
        type: 'counter',
        value: 0,
        labels: { provider: 'codex', session: sessionName, source: 'otel' },
        timestamp: justBefore(event.at),
      })
    }
    this.metricSink.pushMetric({
      name: 'tinstar_provider_session_active_time_seconds_total',
      type: 'counter',
      value: current.activeSeconds,
      labels: { provider: 'codex', session: sessionName, source: 'otel' },
      timestamp: event.at,
    })
  }

  private emitTokenCounters(
    sessionName: string,
    current: CodexSessionTotals,
    timestamp: string,
  ): void {
    for (const token of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'] as const) {
      this.metricSink.pushMetric({
        name: 'tinstar_provider_session_token_usage_total',
        type: 'counter',
        value: current[token],
        labels: {
          provider: 'codex',
          session: sessionName,
          source: 'otel',
          token,
        },
        timestamp,
      })
    }
  }

  private current(sessionName: string, updatedAt: string): CodexSessionTotals {
    let current = this.totals.get(sessionName)
    if (!current) {
      current = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 0,
        activeSeconds: 0,
        updatedAt,
      }
      this.totals.set(sessionName, current)
    }
    return current
  }

  private remember(eventId: string): void {
    this.seen.add(eventId)
    if (this.seen.size <= MAX_SEEN_EVENTS) return
    const oldest = this.seen.values().next().value
    if (oldest) this.seen.delete(oldest)
  }

  private loadState(): void {
    if (!this.statePath) return
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as PersistedCodexTelemetry
      if (parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object') return
      for (const [sessionName, totals] of Object.entries(parsed.sessions)) {
        if (validTotals(totals)) this.totals.set(sessionName, totals)
      }
    } catch {
      // First launch, missing file, or a corrupt cache: start clean. Prometheus
      // still retains previously exported history.
    }
  }

  private persistState(): void {
    if (!this.statePath) return
    try {
      mkdirSync(dirname(this.statePath), { recursive: true })
      const payload: PersistedCodexTelemetry = {
        version: 1,
        sessions: Object.fromEntries(this.totals),
      }
      const temporary = `${this.statePath}.tmp`
      writeFileSync(temporary, JSON.stringify(payload), { mode: 0o600 })
      renameSync(temporary, this.statePath)
    } catch (error) {
      log.warn('codex-otel', `failed to persist normalized telemetry: ${(error as Error).message}`)
    }
  }
}

const ACTIVE_EVENT_NAMES = new Set([
  'codex.api_request',
  'codex.websocket_request',
  'codex.tool_result',
])

interface NormalizedCodexEvent {
  name: string
  kind: string | null
  at: string
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  cacheWriteTokens: number | null
  reasoningTokens: number | null
  totalTokens: number | null
  durationMs: number | null
}

interface OtlpLogRecord {
  record: Record<string, unknown>
  resourceAttributes: Record<string, unknown>
}

function normalizedEvent(input: OtlpLogRecord): NormalizedCodexEvent | null {
  const attributes = {
    ...input.resourceAttributes,
    ...attributesOf(input.record.attributes),
  }
  const name = stringValue(attributes['event.name'])
    ?? stringValue(attributes.event_name)
    ?? stringValue(input.record.eventName)
    ?? stringValue(input.record.name)
    ?? bodyString(input.record.body)
  if (!name?.startsWith('codex.')) return null
  const at = timestampOf(input.record)
  if (!at) return null
  return {
    name,
    kind: stringValue(attributes['event.kind']),
    at,
    model: stringValue(attributes.model),
    inputTokens: numberValue(attributes.input_token_count),
    outputTokens: numberValue(attributes.output_token_count),
    cachedTokens: numberValue(attributes.cached_token_count),
    cacheWriteTokens: numberValue(attributes.cache_write_token_count),
    reasoningTokens: numberValue(attributes.reasoning_token_count),
    totalTokens: numberValue(attributes.tool_token_count),
    durationMs: numberValue(attributes.duration_ms),
  }
}

function logRecords(payload: unknown): OtlpLogRecord[] {
  if (!payload || typeof payload !== 'object') return []
  const resourceLogs = arrayValue((payload as Record<string, unknown>).resourceLogs)
  const out: OtlpLogRecord[] = []
  for (const resourceLog of resourceLogs) {
    if (!resourceLog || typeof resourceLog !== 'object') continue
    const resource = (resourceLog as Record<string, unknown>).resource
    const resourceAttributes = resource && typeof resource === 'object'
      ? attributesOf((resource as Record<string, unknown>).attributes)
      : {}
    const scopes = arrayValue(
      (resourceLog as Record<string, unknown>).scopeLogs
      ?? (resourceLog as Record<string, unknown>).instrumentationLibraryLogs,
    )
    for (const scope of scopes) {
      if (!scope || typeof scope !== 'object') continue
      for (const record of arrayValue((scope as Record<string, unknown>).logRecords)) {
        if (record && typeof record === 'object') {
          out.push({ record: record as Record<string, unknown>, resourceAttributes })
        }
      }
    }
  }
  return out
}

function attributesOf(input: unknown): Record<string, unknown> {
  if (!input) return {}
  if (!Array.isArray(input) && typeof input === 'object') return input as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const entry of arrayValue(input)) {
    if (!entry || typeof entry !== 'object') continue
    const pair = entry as Record<string, unknown>
    const key = stringValue(pair.key)
    if (key) out[key] = otelValue(pair.value)
  }
  return out
}

function otelValue(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input
  const value = input as Record<string, unknown>
  for (const key of ['stringValue', 'intValue', 'doubleValue', 'boolValue'] as const) {
    if (value[key] !== undefined) return value[key]
  }
  return input
}

function timestampOf(record: Record<string, unknown>): string | null {
  const nanos = stringValue(record.timeUnixNano) ?? stringValue(record.observedTimeUnixNano)
  if (nanos && /^\d+$/u.test(nanos)) {
    try { return new Date(Number(BigInt(nanos) / 1_000_000n)).toISOString() } catch { return null }
  }
  const timestamp = stringValue(record.timestamp)
  if (!timestamp || !Number.isFinite(Date.parse(timestamp))) return null
  return new Date(timestamp).toISOString()
}

function bodyString(body: unknown): string | null {
  const value = otelValue(body)
  return stringValue(value)
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  return null
}

function numberValue(value: unknown): number | null {
  const normalized = otelValue(value)
  if (typeof normalized !== 'number' && typeof normalized !== 'string') return null
  const number = Number(normalized)
  return Number.isFinite(number) ? number : null
}

function justBefore(timestamp: string): string {
  return new Date(Math.max(0, Date.parse(timestamp) - 1)).toISOString()
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function tokenBag(input: {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  total: number
}): ProviderTokenUsage {
  return {
    input: input.input,
    output: input.output,
    cacheRead: input.cacheRead,
    cacheWrite: input.cacheWrite,
    reasoning: input.reasoning,
    total: input.total,
  }
}

function validTotals(value: unknown): value is CodexSessionTotals {
  if (!value || typeof value !== 'object') return false
  const totals = value as Partial<CodexSessionTotals>
  return ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'activeSeconds']
    .every(key => typeof totals[key as keyof CodexSessionTotals] === 'number')
    && typeof totals.updatedAt === 'string'
}

class BodyTooLargeError extends Error {}

async function readJsonBody(
  req: import('node:http').IncomingMessage,
  limit: number,
): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new BodyTooLargeError()
    chunks.push(buffer)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

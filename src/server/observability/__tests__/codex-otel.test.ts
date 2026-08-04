import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderObservationIngestor } from '../../providers/observation-ingestor'
import { ProviderCurrentObservationStores } from '../../providers/observation-stores'
import type { Metric } from '../../types'
import { CodexOtelReceiver } from '../codex-otel'

const temporaryPaths: string[] = []

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('CodexOtelReceiver', () => {
  it('normalizes response usage into provider-neutral counters and deduplicates retries', () => {
    const { receiver, stores, metrics } = setup()
    const payload = otlpPayload([
      logRecord('2026-08-04T18:00:00.000Z', 'codex.sse_event', {
        'event.kind': 'response.completed',
        model: 'gpt-5.6-codex',
        input_token_count: 100,
        output_token_count: 50,
        cached_token_count: 20,
        reasoning_token_count: 12,
        tool_token_count: 150,
      }),
    ])

    expect(receiver.ingestPayload('run one', payload)).toBe(1)
    expect(receiver.ingestPayload('run one', payload)).toBe(0)

    const usage = stores.sessions.getUsage('codex', 'run one')
    expect(usage?.source).toEqual({ id: 'codex-otel', label: 'Codex OpenTelemetry' })
    expect(usage?.availability).toMatchObject({
      state: 'available',
      value: {
        model: 'gpt-5.6-codex',
        cumulativeTokens: {
          input: 100,
          output: 50,
          cacheRead: 20,
          reasoning: 12,
          total: 150,
        },
      },
    })
    expect(metrics.filter(metric => (
      metric.name === 'tinstar_provider_session_token_usage_total'
      && metric.labels.token === 'total'
    )).map(metric => metric.value)).toEqual([0, 150])
  })

  it('stitches Codex request and tool duration names into one active-time counter', () => {
    const { receiver, metrics } = setup()
    const payload = otlpPayload([
      logRecord('2026-08-04T18:00:00.000Z', 'codex.api_request', { duration_ms: 1_250 }),
      logRecord('2026-08-04T18:00:02.000Z', 'codex.tool_result', { duration_ms: 750 }),
      logRecord('2026-08-04T18:00:03.000Z', 'codex.user_prompt', { prompt: 'do not retain me' }),
    ])

    expect(receiver.ingestPayload('run-1', payload)).toBe(2)
    const duty = metrics.filter(metric => (
      metric.name === 'tinstar_provider_session_active_time_seconds_total'
    ))
    expect(duty.map(metric => metric.value)).toEqual([0, 1.25, 2])
  })

  it('persists only normalized numbers and resumes cumulative history after restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tinstar-codex-otel-'))
    temporaryPaths.push(directory)
    const statePath = join(directory, 'state.json')
    const first = setup(statePath)
    first.receiver.ingestPayload('run-1', otlpPayload([
      {
        ...logRecord('2026-08-04T18:00:00.000Z', 'codex.sse_event', {
          'event.kind': 'response.completed',
          input_token_count: 10,
          output_token_count: 5,
          tool_token_count: 15,
        }),
        body: { stringValue: 'secret prompt and tool output' },
      },
    ]))

    expect(readFileSync(statePath, 'utf8')).not.toContain('secret prompt')

    const second = setup(statePath)
    second.receiver.ingestPayload('run-1', otlpPayload([
      logRecord('2026-08-04T18:01:00.000Z', 'codex.sse_event', {
        'event.kind': 'response.completed',
        input_token_count: 20,
        output_token_count: 10,
        tool_token_count: 30,
      }),
    ]))
    const totals = second.metrics.filter(metric => (
      metric.name === 'tinstar_provider_session_token_usage_total'
      && metric.labels.token === 'total'
    ))
    expect(totals.at(-1)?.value).toBe(45)
  })
})

function setup(statePath: string | null = null) {
  const stores = new ProviderCurrentObservationStores()
  const metrics: Metric[] = []
  const metricSink = { pushMetric: (metric: Metric) => metrics.push(metric) }
  const ingestor = new ProviderObservationIngestor({ stores, sink: metricSink })
  return {
    stores,
    metrics,
    receiver: new CodexOtelReceiver({ ingestor, metricSink, statePath, port: 0 }),
  }
}

function otlpPayload(logRecords: unknown[]) {
  return {
    resourceLogs: [{
      resource: { attributes: [attribute('service.name', 'codex_cli_rs')] },
      scopeLogs: [{ scope: { name: 'codex' }, logRecords }],
    }],
  }
}

function logRecord(at: string, eventName: string, values: Record<string, string | number>) {
  return {
    timeUnixNano: String(Date.parse(at) * 1_000_000),
    attributes: [
      attribute('event.name', eventName),
      ...Object.entries(values).map(([key, value]) => attribute(key, value)),
    ],
  }
}

function attribute(key: string, value: string | number) {
  return {
    key,
    value: typeof value === 'number'
      ? { intValue: String(value) }
      : { stringValue: value },
  }
}

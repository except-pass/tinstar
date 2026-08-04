import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CodexRolloutObservationSource,
  parseCodexObservationLine,
} from '../codex-transcript'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tinstar-codex-observations-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function tokenCountRecord(
  timestamp: string,
  totalTokens: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: totalTokens - 300,
          cached_input_tokens: 400,
          cache_write_input_tokens: 25,
          output_tokens: 300,
          reasoning_output_tokens: 75,
          total_tokens: totalTokens,
        },
        last_token_usage: {
          input_tokens: 1_500,
          cached_input_tokens: 350,
          cache_write_input_tokens: 10,
          output_tokens: 300,
          reasoning_output_tokens: 50,
          total_tokens: 1_800,
        },
        model_context_window: 10_000,
        future_usage_field: 'ignored',
      },
      rate_limits: {
        limit_id: 'codex',
        limit_name: 'Codex allowance',
        primary: {
          used_percent: 20,
          window_minutes: 300,
          resets_at: 1_788_200_000,
          future_window_field: 'ignored',
        },
        secondary: {
          used_percent: 30,
          window_minutes: 10_080,
          resets_in_seconds: 3_600,
        },
        credits: {
          has_credits: true,
          unlimited: false,
          balance: '17.50',
          account_id: 'ACCOUNT_VALUE_MUST_NOT_SURVIVE',
        },
        plan_type: 'synthetic-plan',
        future_rate_limit_field: 'ignored',
      },
      raw_prompt: 'PROMPT_MUST_NOT_SURVIVE',
      ...overrides,
    },
  }
}

function line(record: object): string {
  return `${JSON.stringify(record)}\n`
}

function turnContext(model: string): Record<string, unknown> {
  return {
    timestamp: '2026-08-01T11:59:59.000Z',
    type: 'turn_context',
    payload: { model },
  }
}

describe('parseCodexObservationLine', () => {
  it('normalizes usage, context, quota, resets, credits, and plan fields', () => {
    const parsed = parseCodexObservationLine(JSON.stringify(
      tokenCountRecord('2026-08-01T12:00:00.000Z', 8_000),
    ))

    expect(parsed).toMatchObject({
      observedAt: '2026-08-01T12:00:00.000Z',
      sessionUsage: {
        cumulativeTokens: {
          input: 7_700,
          cacheRead: 400,
          cacheWrite: 25,
          output: 300,
          reasoning: 75,
          total: 8_000,
        },
        latestTurnTokens: {
          input: 1_500,
          cacheRead: 350,
          cacheWrite: 10,
          output: 300,
          reasoning: 50,
          total: 1_800,
        },
      },
      sessionContext: {
        usedTokens: 1_750,
        windowTokens: 10_000,
        usedPercent: 17.5,
      },
      providerQuota: {
        windows: [
          {
            id: 'primary',
            label: 'Primary',
            windowMinutes: 300,
            usedPercent: 20,
            resetsAt: '2026-08-31T18:13:20.000Z',
          },
          {
            id: 'secondary',
            label: 'Secondary',
            windowMinutes: 10_080,
            usedPercent: 30,
            resetsAt: '2026-08-01T13:00:00.000Z',
          },
        ],
      },
      detail: {
        limitId: 'codex',
        limitName: 'Codex allowance',
        planType: 'synthetic-plan',
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: '17.50',
        },
      },
    })
    expect(parsed?.id).toMatch(/^[a-f0-9]{64}$/)

    const serialized = JSON.stringify(parsed)
    expect(serialized).not.toContain('PROMPT_MUST_NOT_SURVIVE')
    expect(serialized).not.toContain('ACCOUNT_VALUE_MUST_NOT_SURVIVE')
    expect(serialized).not.toContain('future_usage_field')
    expect(serialized).not.toContain('future_rate_limit_field')
  })

  it('emits quota-only snapshots and ignores unrelated or malformed records', () => {
    const quotaOnly = tokenCountRecord('2026-08-01T12:00:00.000Z', 8_000, { info: null })

    const parsed = parseCodexObservationLine(JSON.stringify(quotaOnly))
    expect(parsed).toMatchObject({
      providerQuota: { windows: expect.any(Array) },
    })
    expect(parsed).not.toHaveProperty('sessionUsage')
    expect(parsed).not.toHaveProperty('sessionContext')
    expect(parseCodexObservationLine('{unfinished')).toBeNull()
    expect(parseCodexObservationLine(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'future_event', private_value: 'ignored' },
    }))).toBeNull()
  })
})

describe('CodexRolloutObservationSource', () => {
  it('retains the active model across incremental reads without treating replay as new history', () => {
    const source = new CodexRolloutObservationSource()
    const path = join(scratch, 'rollout.jsonl')
    writeFileSync(
      path,
      line(turnContext('gpt-5.4'))
        + line(tokenCountRecord('2026-08-01T12:00:00.000Z', 8_000)),
    )

    const replay = source.read('session-a', path)
    expect(replay).toHaveLength(1)
    expect(replay[0]).toMatchObject({
      replayed: true,
      sessionUsage: { model: 'gpt-5.4' },
    })

    appendFileSync(
      path,
      line(tokenCountRecord('2026-08-01T12:01:00.000Z', 9_000)),
    )
    const incremental = source.read('session-a', path)
    expect(incremental).toHaveLength(1)
    expect(incremental[0]).toMatchObject({
      replayed: false,
      sessionUsage: { model: 'gpt-5.4' },
    })
  })

  it('drops retained model state on rotation, truncation, and incarnation reset', () => {
    const source = new CodexRolloutObservationSource()
    const path = join(scratch, 'rollout.jsonl')
    const rotatedPath = join(scratch, 'rollout.old.jsonl')
    writeFileSync(
      path,
      line(turnContext('gpt-old'))
        + line(tokenCountRecord('2026-08-01T12:00:00.000Z', 8_000)),
    )
    expect(source.read('session-a', path)[0]?.sessionUsage?.model).toBe('gpt-old')

    renameSync(path, rotatedPath)
    writeFileSync(path, line(tokenCountRecord('2026-08-01T12:01:00.000Z', 9_000)))
    expect(source.read('session-a', path)[0]?.sessionUsage).not.toHaveProperty('model')

    writeFileSync(
      path,
      line(turnContext('gpt-truncated'))
        + line(tokenCountRecord('2026-08-01T12:02:00.000Z', 10_000)),
    )
    expect(source.read('session-a', path)[0]?.sessionUsage?.model).toBe('gpt-truncated')

    source.reset('session-a')
    writeFileSync(path, line(tokenCountRecord('2026-08-01T12:03:00.000Z', 11_000)))
    expect(source.read('session-a', path)[0]?.sessionUsage).not.toHaveProperty('model')
  })

  it('waits for a newline-terminated JSON record and emits it exactly once', () => {
    const source = new CodexRolloutObservationSource()
    const path = join(scratch, 'rollout.jsonl')
    const record = JSON.stringify(tokenCountRecord('2026-08-01T12:00:00.000Z', 8_000))
    const splitAt = Math.floor(record.length / 2)
    writeFileSync(path, record.slice(0, splitAt))

    expect(source.read('session-a', path)).toEqual([])
    appendFileSync(path, `${record.slice(splitAt)}\n`)

    expect(source.read('session-a', path)).toHaveLength(1)
    expect(source.read('session-a', path)).toEqual([])
  })

  it('survives file rotation, suppresses replayed records, and keeps sessions isolated', () => {
    const source = new CodexRolloutObservationSource()
    const path = join(scratch, 'rollout.jsonl')
    const rotatedPath = join(scratch, 'rollout.old.jsonl')
    const first = tokenCountRecord('2026-08-01T12:00:00.000Z', 8_000)
    const second = tokenCountRecord('2026-08-01T12:01:00.000Z', 9_000)
    writeFileSync(path, line(first))

    expect(source.read('session-a', path)).toHaveLength(1)

    renameSync(path, rotatedPath)
    writeFileSync(path, line(first) + line(second))

    const afterRotation = source.read('session-a', path)
    expect(afterRotation).toHaveLength(1)
    expect(afterRotation[0]).toMatchObject({
      replayed: false,
      sessionUsage: { cumulativeTokens: { total: 9_000 } },
    })

    expect(source.read('session-b', path)).toEqual([
      expect.objectContaining({ replayed: true }),
      expect.objectContaining({ replayed: true }),
    ])
  })

  it('detects same-path truncate-and-regrow replacement without losing new events', () => {
    const source = new CodexRolloutObservationSource()
    const path = join(scratch, 'rollout.jsonl')
    const first = tokenCountRecord('2026-08-01T12:00:00.000Z', 8_000)
    const second = tokenCountRecord('2026-08-01T12:01:00.000Z', 9_000)
    writeFileSync(path, line(first))
    expect(source.read('session-a', path)).toHaveLength(1)

    const harmlessPadding = line({
      type: 'future_record',
      payload: { padding: 'x'.repeat(2_000) },
    })
    writeFileSync(path, harmlessPadding + line(second))

    const afterReplacement = source.read('session-a', path)
    expect(afterReplacement).toHaveLength(1)
    expect(afterReplacement[0]).toMatchObject({
      replayed: false,
      sessionUsage: { cumulativeTokens: { total: 9_000 } },
    })
  })

  it('discards an oversized partial record and resumes at the next newline', () => {
    const source = new CodexRolloutObservationSource()
    const path = join(scratch, 'rollout.jsonl')
    writeFileSync(
      path,
      `{"type":"response_item","payload":"${'x'.repeat(1_100_000)}`,
    )

    expect(source.read('session-a', path)).toEqual([])
    appendFileSync(
      path,
      `"}\n${line(tokenCountRecord('2026-08-01T12:02:00.000Z', 10_000))}`,
    )

    const events = source.read('session-a', path)
    expect(events).toHaveLength(1)
    expect(events[0]?.sessionUsage?.cumulativeTokens?.total).toBe(10_000)
  })
})

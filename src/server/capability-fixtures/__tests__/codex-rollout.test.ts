/**
 * Characterization: what a Codex rollout JSONL natively gives us.
 *
 * Two kinds of assertion live here, deliberately mixed:
 *
 *  1. Behavioural — the frozen fixtures are fed to the REAL readers
 *     (`readCodexStatus`, `parseCodexRecapEntries`) so a change in derivation
 *     fails here.
 *  2. Structural — `token_count` payloads have no reader yet (normalizing them
 *     is a later task), so their native shape is pinned directly. That is the
 *     spec the future normalizer has to satisfy, including the shapes where
 *     fields are absent or null.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCodexStatus, parseCodexRecapEntries, resetCodexOffset } from '../../sessions/codex-transcript'
import {
  CODEX_ROLLOUT_FIXTURES,
  codexEventPayloads,
  codexRolloutPath,
  loadCodexRollout,
  readCodexRolloutText,
} from '../index'

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'codex-fixture-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

/** Copy a fixture into the temp dir so offset/rotation tests can mutate it. */
function scratch(fixture: Parameters<typeof codexRolloutPath>[0], as = 'rollout.jsonl'): string {
  const dest = join(tmp, as)
  copyFileSync(codexRolloutPath(fixture), dest)
  return dest
}

/* ------------------------------------------------------------------ */
/*  token_count — usage, context window, quota                         */
/* ------------------------------------------------------------------ */

describe('Codex token_count — the native usage/quota signal', () => {
  it('emits total and last usage side by side, with the same six counters', () => {
    const events = codexEventPayloads('rollout-root-session', 'token_count')
    expect(events).toHaveLength(2)

    const counters = {
      input_tokens: expect.any(Number),
      cached_input_tokens: expect.any(Number),
      cache_write_input_tokens: expect.any(Number),
      output_tokens: expect.any(Number),
      reasoning_output_tokens: expect.any(Number),
      total_tokens: expect.any(Number),
    }
    for (const e of events) {
      expect(e.info).toMatchObject({ total_token_usage: counters, last_token_usage: counters })
    }
  })

  it('total accumulates across the thread while last is scoped to one request', () => {
    const [first, last] = codexEventPayloads('rollout-root-session', 'token_count') as [
      { info: { total_token_usage: { total_tokens: number }; last_token_usage: { total_tokens: number } } },
      { info: { total_token_usage: { total_tokens: number }; last_token_usage: { total_tokens: number } } },
    ]
    // On the first event of a thread the two are identical — a normalizer that
    // reads either one looks correct until the second turn arrives.
    expect(first.info.total_token_usage).toEqual(first.info.last_token_usage)
    expect(last.info.total_token_usage.total_tokens).toBeGreaterThan(first.info.total_token_usage.total_tokens)
    expect(last.info.last_token_usage.total_tokens).toBeLessThan(last.info.total_token_usage.total_tokens)
  })

  it('carries model_context_window inside info — the denominator for context %', () => {
    for (const e of codexEventPayloads('rollout-root-session', 'token_count')) {
      expect(e.info).toMatchObject({ model_context_window: 258400 })
    }
  })

  it('puts rate_limits BESIDE info, not inside it', () => {
    const [first] = codexEventPayloads('rollout-root-session', 'token_count')
    expect(first).toHaveProperty('rate_limits')
    expect(first?.info).not.toHaveProperty('rate_limits')
    expect(first?.rate_limits).toMatchObject({
      limit_id: 'codex',
      limit_name: null,
      primary: { used_percent: 40, window_minutes: 10080, resets_at: 1785960000 },
      secondary: null,
      credits: { has_credits: false, unlimited: false, balance: '0' },
      individual_limit: null,
      spend_control_reached: null,
      plan_type: 'prolite',
      rate_limit_reached_type: null,
    })
  })

  it('expresses quota as used_percent + window_minutes + epoch reset (not Claude 5h/7d buckets)', () => {
    const events = codexEventPayloads('rollout-root-session', 'token_count')
    const second = events[1] as { rate_limits: Record<string, unknown> }
    // Both windows can be populated; the window length is data, not a fixed name.
    expect(second.rate_limits.primary).toMatchObject({ window_minutes: 10080 })
    expect(second.rate_limits.secondary).toMatchObject({
      used_percent: 8.5,
      window_minutes: 300,
      resets_at: expect.any(Number),
    })
    expect(second.rate_limits.credits).toMatchObject({
      has_credits: true,
      unlimited: false,
      balance: '12.50', // a STRING, not a number
    })
  })
})

describe('Codex token_count — absent and partial fields', () => {
  const events = () => codexEventPayloads('rollout-partial-token-count', 'token_count')

  it('may omit rate_limits and model_context_window entirely', () => {
    const first = events()[0] as { info: Record<string, unknown> }
    expect(first).not.toHaveProperty('rate_limits')
    expect(first.info).not.toHaveProperty('model_context_window')
    expect(first.info).toHaveProperty('total_token_usage')
  })

  it('may omit last_token_usage while still reporting a total', () => {
    const second = events()[1] as { info: Record<string, unknown> }
    expect(second.info).not.toHaveProperty('last_token_usage')
    expect(second.info).toMatchObject({ model_context_window: 272000 })
  })

  it('may report rate_limits whose every member is null — present but empty', () => {
    const second = events()[1] as { rate_limits: Record<string, unknown> }
    expect(second.rate_limits).toMatchObject({
      limit_id: 'codex',
      primary: null,
      secondary: null,
      credits: null,
      plan_type: null,
    })
  })

  it('may carry a null info — the event exists with no usage at all', () => {
    expect(events()[2]).toEqual({ type: 'token_count', info: null })
  })
})

/* ------------------------------------------------------------------ */
/*  Thread identity, resume, spawn, and rotation                       */
/* ------------------------------------------------------------------ */

describe('Codex session_meta — thread identity and lineage', () => {
  it('a root thread has session_id === id and no parent', () => {
    const meta = loadCodexRollout('rollout-root-session')[0]
    expect(meta?.type).toBe('session_meta')
    const p = meta?.payload as Record<string, unknown>
    expect(p.session_id).toBe(p.id)
    expect(p).not.toHaveProperty('parent_thread_id')
    expect(p).toMatchObject({
      thread_source: 'user',
      source: 'cli', // a plain string on a root thread
      originator: 'codex-tui',
      cli_version: expect.any(String),
      model_provider: 'openai',
      cwd: '/home/fixture/repo/demo',
    })
  })

  it('a spawned subagent keeps the parent session_id but gets a fresh id', () => {
    const meta = loadCodexRollout('rollout-spawned-thread')[0]
    const p = meta?.payload as Record<string, unknown>
    expect(p.session_id).toBe('019f0000-0001-7000-8000-000000000001') // the parent thread
    expect(p.id).toBe('019f0000-0002-7000-8000-000000000002')          // this rollout
    expect(p.session_id).not.toBe(p.id)
    expect(p).toMatchObject({
      parent_thread_id: '019f0000-0001-7000-8000-000000000001',
      thread_source: 'subagent',
      agent_nickname: 'Fixture',
      // `source` flips from string to object once a thread has a parent.
      source: { subagent: { thread_spawn: { depth: 1, agent_nickname: 'Fixture' } } },
    })
  })

  it('resume appends a turn to the same rollout and keeps the root identity', () => {
    const lines = loadCodexRollout('rollout-resumed-session')
    const metas = lines.filter(line => line.type === 'session_meta')
    expect(metas).toHaveLength(1)

    const p = metas[0]?.payload as Record<string, unknown>
    expect(p.session_id).toBe(p.id)
    expect(p).not.toHaveProperty('parent_thread_id')
    expect(p).toMatchObject({
      thread_source: 'user',
      source: 'cli',
      originator: 'codex-tui',
    })

    expect(codexEventPayloads('rollout-resumed-session', 'thread_settings_applied')).toHaveLength(1)
    expect(codexEventPayloads('rollout-resumed-session', 'task_started')).toHaveLength(2)
    expect(codexEventPayloads('rollout-resumed-session', 'user_message')).toHaveLength(2)
    expect(codexEventPayloads('rollout-resumed-session', 'task_complete')).toHaveLength(2)
  })

  it('a root meta may carry git provenance and a context_window id; a lean one may not', () => {
    const root = loadCodexRollout('rollout-root-session')[0]?.payload as Record<string, unknown>
    expect(root).toMatchObject({
      git: { commit_hash: expect.any(String), branch: 'main', repository_url: expect.any(String) },
      context_window: { window_id: expect.any(String) },
      history_mode: 'legacy',
    })
    const lean = loadCodexRollout('rollout-partial-token-count')[0]?.payload as Record<string, unknown>
    expect(lean).not.toHaveProperty('git')
    expect(lean).not.toHaveProperty('context_window')
    expect(lean).toMatchObject({ originator: 'codex-exec' })
  })
})

describe('Codex compaction and abort', () => {
  it('compaction writes a top-level `compacted` envelope plus a context_compacted marker', () => {
    const lines = loadCodexRollout('rollout-spawned-thread')
    const compacted = lines.find(l => l.type === 'compacted')
    expect(compacted?.payload).toMatchObject({ replacement_history: expect.any(Array) })
    // The marker is an event_msg — note the two spellings are NOT the same record.
    expect(codexEventPayloads('rollout-spawned-thread', 'context_compacted')).toHaveLength(1)
  })

  it('an interrupted turn is recorded as turn_aborted with a reason and duration', () => {
    const [started] = codexEventPayloads('rollout-spawned-thread', 'task_started')
    const [aborted] = codexEventPayloads('rollout-spawned-thread', 'turn_aborted')
    expect(aborted).toMatchObject({
      turn_id: expect.any(String),
      reason: 'interrupted',
      completed_at: expect.any(Number),
      duration_ms: expect.any(Number),
    })

    const startedAt = started?.started_at as number
    const completedAt = aborted?.completed_at as number
    const durationMs = aborted?.duration_ms as number
    expect(completedAt).toBeGreaterThanOrEqual(startedAt)
    expect(Math.abs((completedAt - startedAt) - durationMs / 1000)).toBeLessThan(1)
  })

  it('task_started carries the context window and turn id up front', () => {
    const [started] = codexEventPayloads('rollout-root-session', 'task_started')
    expect(started).toMatchObject({
      turn_id: expect.any(String),
      started_at: expect.any(Number),
      model_context_window: 258400,
      collaboration_mode_kind: 'default',
    })
    // …but a leaner CLI build omits both of the trailing two.
    const [lean] = codexEventPayloads('rollout-partial-token-count', 'task_started')
    expect(lean).not.toHaveProperty('model_context_window')
  })
})

describe('Codex rollout chronology', () => {
  const expectedTaskStarts = [
    ['rollout-root-session', 1],
    ['rollout-resumed-session', 2],
    ['rollout-spawned-thread', 1],
    ['rollout-partial-token-count', 1],
    ['rollout-malformed-tail', 0],
  ] as const

  it.each(CODEX_ROLLOUT_FIXTURES)('%s keeps timestamped append order monotonic', (fixture) => {
    const envelopeTimes = loadCodexRollout(fixture)
      .map(line => line.timestamp)
      .filter((timestamp): timestamp is string => typeof timestamp === 'string')
      .map(timestamp => Date.parse(timestamp))
    expect(envelopeTimes.every(Number.isFinite)).toBe(true)
    expect(envelopeTimes).toEqual([...envelopeTimes].sort((a, b) => a - b))
  })

  it.each(expectedTaskStarts)('%s keeps its expected task_started count', (fixture, count) => {
    expect(codexEventPayloads(fixture, 'task_started')).toHaveLength(count)
  })

  it.each(CODEX_ROLLOUT_FIXTURES)('%s aligns task_started epochs with their envelopes', (fixture) => {
    const startedLines = loadCodexRollout(fixture).filter(
      line => line.type === 'event_msg' && line.payload?.type === 'task_started',
    )
    for (const line of startedLines) {
      const envelopeMs = Date.parse(line.timestamp ?? '')
      const startedAt = line.payload?.started_at
      expect(Number.isFinite(envelopeMs)).toBe(true)
      expect(startedAt).toEqual(expect.any(Number))
      const writeDelaySeconds = envelopeMs / 1000 - (startedAt as number)
      expect(writeDelaySeconds).toBeGreaterThanOrEqual(0)
      expect(writeDelaySeconds).toBeLessThan(2)
    }
  })
})

/* ------------------------------------------------------------------ */
/*  Status derivation (real reader)                                    */
/* ------------------------------------------------------------------ */

describe('readCodexStatus over the frozen rollouts', () => {
  it('reports idle after task_complete, even with a token_count in between', () => {
    expect(readCodexStatus(scratch('rollout-root-session'))).toBe('idle')
  })

  it('reports idle for the partial-usage rollout (task_complete is still the last lifecycle event)', () => {
    expect(readCodexStatus(scratch('rollout-partial-token-count'))).toBe('idle')
  })

  it('skips malformed and truncated lines and reads the last good lifecycle event', () => {
    expect(readCodexStatus(scratch('rollout-malformed-tail'))).toBe('idle')
  })

  it('KNOWN GAP: an aborted turn still reads as running — turn_aborted is not a lifecycle event today', () => {
    // The tail is turn_aborted → context_compacted → compacted → token_count,
    // none of which the reader recognizes, so it walks back to task_started.
    // Pinned so the provider plane closes this deliberately, not by accident.
    expect(readCodexStatus(scratch('rollout-spawned-thread'))).toBe('running')
  })

  it('returns null for a missing file and for a file with no recognizable events', () => {
    expect(readCodexStatus(join(tmp, 'nope.jsonl'))).toBeNull()
    const empty = join(tmp, 'empty.jsonl')
    writeFileSync(empty, '{"type":"response_item_unknown"}\n')
    expect(readCodexStatus(empty)).toBeNull()
  })

  it('reports running while a response_item is the newest record', () => {
    const p = join(tmp, 'mid-turn.jsonl')
    writeFileSync(
      p,
      readCodexRolloutText('rollout-root-session')
        .split('\n')
        .filter(l => l.trim() && !l.includes('"task_complete"') && !l.includes('"agent_message"'))
        .join('\n') + '\n',
    )
    expect(readCodexStatus(p)).toBe('running')
  })
})

/* ------------------------------------------------------------------ */
/*  Recap parsing, incremental offsets, rotation                       */
/* ------------------------------------------------------------------ */

describe('parseCodexRecapEntries over the frozen rollouts', () => {
  it('extracts user_message and task_complete.last_agent_message, in file order', () => {
    resetCodexOffset('recap-basic')
    const entries = parseCodexRecapEntries('recap-basic', scratch('rollout-root-session'))
    expect(entries.map(e => ({ type: e.type, content: e.content }))).toEqual([
      { type: 'user', content: 'add a fixture' },
      { type: 'agent', content: 'Added the fixture.' },
    ])
    // Timestamps come from the envelope, not the payload.
    expect(entries[0]?.timestamp).toBe('2026-07-30T18:33:38.010Z')
  })

  it('ignores agent_message events — only task_complete closes a turn', () => {
    resetCodexOffset('recap-agentmsg')
    const entries = parseCodexRecapEntries('recap-agentmsg', scratch('rollout-root-session'))
    // The rollout contains an agent_message with the same text; exactly one
    // agent entry is produced, so the two are not double-counted.
    expect(entries.filter(e => e.type === 'agent')).toHaveLength(1)
  })

  it('is incremental: a second call over an unchanged file returns nothing', () => {
    const path = scratch('rollout-root-session')
    resetCodexOffset('recap-incr')
    expect(parseCodexRecapEntries('recap-incr', path).length).toBeGreaterThan(0)
    expect(parseCodexRecapEntries('recap-incr', path)).toEqual([])
  })

  it('picks up only the appended tail after the file grows', () => {
    const path = scratch('rollout-root-session')
    resetCodexOffset('recap-append')
    parseCodexRecapEntries('recap-append', path)
    writeFileSync(
      path,
      '{"timestamp":"2026-07-30T19:00:00.000Z","type":"event_msg","payload":{"type":"user_message","message":"second prompt"}}\n',
      { flag: 'a' },
    )
    expect(parseCodexRecapEntries('recap-append', path).map(e => e.content)).toEqual(['second prompt'])
  })

  it('resume appends the second turn to the same rollout and incremental parsing sees only that turn', () => {
    const lines = readCodexRolloutText('rollout-resumed-session').trimEnd().split('\n')
    const resumeMarker = lines.findIndex(line => line.includes('"thread_settings_applied"'))
    expect(resumeMarker).toBeGreaterThan(0)

    const path = join(tmp, 'resumed.jsonl')
    writeFileSync(path, `${lines.slice(0, resumeMarker).join('\n')}\n`)
    resetCodexOffset('recap-resume')
    expect(parseCodexRecapEntries('recap-resume', path).map(e => e.content)).toEqual([
      'first synthetic prompt',
      'First synthetic answer.',
    ])

    writeFileSync(path, `${lines.slice(resumeMarker).join('\n')}\n`, { flag: 'a' })
    expect(parseCodexRecapEntries('recap-resume', path).map(e => e.content)).toEqual([
      'second synthetic prompt',
      'Second synthetic answer.',
    ])
  })

  it('rotation: a file that shrank is re-read from byte 0', () => {
    const path = scratch('rollout-root-session')
    resetCodexOffset('recap-rotate')
    parseCodexRecapEntries('recap-rotate', path)
    // If a watched rollout path is replaced by a shorter file, the offset must
    // reset independently of resume (which appends to the existing rollout).
    copyFileSync(codexRolloutPath('rollout-partial-token-count'), path)
    expect(parseCodexRecapEntries('recap-rotate', path).map(e => e.content)).toEqual(['Done.'])
  })

  it('skips blank, non-JSON, and truncated lines without losing the good ones', () => {
    resetCodexOffset('recap-malformed')
    const entries = parseCodexRecapEntries('recap-malformed', scratch('rollout-malformed-tail'))
    expect(entries.map(e => e.content)).toEqual(['first prompt', 'First answer.'])
  })

  it('returns [] for a missing file', () => {
    resetCodexOffset('recap-missing')
    expect(parseCodexRecapEntries('recap-missing', join(tmp, 'nope.jsonl'))).toEqual([])
  })
})

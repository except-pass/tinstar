import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildSessionTimeline, __resetTimelineCache } from '../index'

const iso = (sec: number): string => new Date(sec * 1000).toISOString()
const line = (sec: number): string =>
  JSON.stringify({ type: 'user', timestamp: iso(sec), message: { content: 'go' } }) + '\n'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tlc-')); __resetTimelineCache() })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('buildSessionTimeline cache', () => {
  it('does not re-read a transcript whose size is unchanged (R14, AE7)', () => {
    const p = join(dir, 'c.jsonl')
    writeFileSync(p, line(0) + line(60))
    const session = { name: 's', adapter: 'claude', transcriptPath: p, createdSec: 0 }

    const first = buildSessionTimeline(session)!
    expect(first.t1).toBe(60)

    // Rewrite with different timestamps but an identical byte length. ISO
    // timestamps are fixed-width, so this changes content without changing
    // size — if the cache re-read the file, t1 would move.
    writeFileSync(p, line(0) + line(600))
    expect(buildSessionTimeline(session)!.t1).toBe(60)
  })

  it('re-reads once the file grows', () => {
    const p = join(dir, 'c.jsonl')
    writeFileSync(p, line(0))
    const session = { name: 's', adapter: 'claude', transcriptPath: p, createdSec: 0 }
    const before = buildSessionTimeline(session)!
    appendFileSync(p, line(600))
    expect(buildSessionTimeline(session)!.t1).toBeGreaterThan(before.t1)
  })

  it('returns null when no transcript path resolves (R18)', () => {
    expect(buildSessionTimeline({ name: 'marshal', adapter: 'codex', transcriptPath: null, createdSec: 0 })).toBeNull()
  })

  it('returns null when the transcript file is missing', () => {
    expect(buildSessionTimeline({ name: 'gone', adapter: 'claude', transcriptPath: join(dir, 'nope.jsonl'), createdSec: 0 })).toBeNull()
  })

  it('bands tile the whole span (R2)', () => {
    const p = join(dir, 'c.jsonl')
    writeFileSync(p, [
      { type: 'user', timestamp: iso(0), message: { content: 'go' } },
      { type: 'assistant', timestamp: iso(1), message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
      { type: 'user', timestamp: iso(4), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
    ].map(o => JSON.stringify(o)).join('\n') + '\n')
    const tl = buildSessionTimeline({ name: 's2', adapter: 'claude', transcriptPath: p, createdSec: 0 })!
    const total = tl.bands.reduce((s, b) => s + (b.end - b.start), 0)
    expect(total).toBeCloseTo(tl.t1 - tl.t0, 3)
  })

  it('keeps separate cache entries per session', () => {
    const a = join(dir, 'a.jsonl')
    const b = join(dir, 'b.jsonl')
    writeFileSync(a, line(0) + line(60))
    writeFileSync(b, line(0))
    const ta = buildSessionTimeline({ name: 'a', adapter: 'claude', transcriptPath: a, createdSec: 0 })!
    const tb = buildSessionTimeline({ name: 'b', adapter: 'claude', transcriptPath: b, createdSec: 0 })!
    expect(ta.t1).toBe(60)
    expect(tb.t1).toBe(0)
  })
})

describe('live edge (regression: in-flight band clipped to zero)', () => {
  const nowSec = 1785000000

  it('renders a run parked on an unanswered prompt right now', () => {
    // The feature's core live case. Last entry is a tool_use issued 30 minutes
    // ago with no result; without extending the right edge past the last entry,
    // flatten clipped this to zero width and the stall showed as nothing.
    const p = join(dir, 'stuck.jsonl')
    writeFileSync(p, [
      { type: 'user', timestamp: iso(nowSec - 3600), message: { content: 'go' } },
      { type: 'assistant', timestamp: iso(nowSec - 1800), message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf /tmp/x' } }] } },
    ].map(o => JSON.stringify(o)).join('\n') + '\n')

    const tl = buildSessionTimeline(
      { name: 'stuck', adapter: 'claude', transcriptPath: p, createdSec: nowSec - 3600 }, nowSec)!

    expect(tl.t1).toBeCloseTo(nowSec, 0)
    const pending = tl.bands.find(b => b.name.includes('Bash'))
    expect(pending).toBeDefined()
    expect(pending!.end - pending!.start).toBeCloseTo(1800, 0)
  })

  it('leaves the right edge at the last entry when nothing is in flight', () => {
    const p = join(dir, 'settled.jsonl')
    writeFileSync(p, [
      { type: 'user', timestamp: iso(nowSec - 3600), message: { content: 'go' } },
      { type: 'assistant', timestamp: iso(nowSec - 3000), message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
      { type: 'user', timestamp: iso(nowSec - 2990), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
    ].map(o => JSON.stringify(o)).join('\n') + '\n')

    const tl = buildSessionTimeline(
      { name: 'settled', adapter: 'claude', transcriptPath: p, createdSec: nowSec - 3600 }, nowSec)!
    expect(tl.t1).toBeCloseTo(nowSec - 2990, 0)
  })
})

describe('implausible timestamps (regression: 229-year span)', () => {
  it('drops a future-dated entry instead of stretching the span to centuries', () => {
    const nowSec = 1785000000
    const p = join(dir, 'skew.jsonl')
    writeFileSync(p, [
      { type: 'user', timestamp: iso(nowSec - 600), message: { content: 'go' } },
      { type: 'user', timestamp: new Date('2255-01-01T00:00:00Z').toISOString(), message: { content: 'skewed' } },
    ].map(o => JSON.stringify(o)).join('\n') + '\n')

    const tl = buildSessionTimeline(
      { name: 'skew', adapter: 'claude', transcriptPath: p, createdSec: nowSec - 600 }, nowSec)!
    expect(tl.t1 - tl.t0).toBeLessThan(3600)
  })
})

describe('incremental parsing (R14)', () => {
  it('an incrementally-grown parse matches a from-scratch parse', () => {
    // The whole point of R14: reading only appended bytes must produce exactly
    // what re-reading the file from byte zero would.
    const p = join(dir, 'grow.jsonl')
    const rows = [
      { type: 'user', timestamp: iso(0), message: { content: 'go' } },
      { type: 'assistant', timestamp: iso(1), message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } },
      { type: 'user', timestamp: iso(4), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] } },
      { type: 'user', timestamp: iso(400), message: { content: 'again' } },
      { type: 'assistant', timestamp: iso(402), message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: {} }] } },
      { type: 'user', timestamp: iso(410), message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'y' }] } },
    ].map(o => JSON.stringify(o) + '\n')

    // grown one row at a time
    writeFileSync(p, '')
    const input = { name: 'grow', adapter: 'claude', transcriptPath: p, createdSec: 0 }
    for (const row of rows) { appendFileSync(p, row); buildSessionTimeline(input, 1000) }
    const incremental = buildSessionTimeline(input, 1000)!

    // same bytes, parsed cold
    const q = join(dir, 'whole.jsonl')
    writeFileSync(q, rows.join(''))
    const whole = buildSessionTimeline({ name: 'whole', adapter: 'claude', transcriptPath: q, createdSec: 0 }, 1000)!

    expect(incremental.t0).toBe(whole.t0)
    expect(incremental.t1).toBe(whole.t1)
    expect(incremental.turns).toEqual(whole.turns)
    expect(incremental.bands.map(b => [b.kind, b.start, b.end]))
      .toEqual(whole.bands.map(b => [b.kind, b.start, b.end]))
  })

  it('tolerates a half-written trailing line', () => {
    const p = join(dir, 'partial.jsonl')
    writeFileSync(p, line(0) + '{"type":"user","timesta')
    const input = { name: 'partial', adapter: 'claude', transcriptPath: p, createdSec: 0 }
    expect(buildSessionTimeline(input, 1000)!.t1).toBe(0)
    // the rest of the line arrives
    appendFileSync(p, 'mp":"' + iso(120) + '","message":{"content":"go"}}\n')
    expect(buildSessionTimeline(input, 1000)!.t1).toBe(120)
  })

  it('re-parses from scratch when the transcript path changes', () => {
    // A recreated session reusing a name must not inherit its predecessor.
    const a = join(dir, 'first.jsonl')
    const b = join(dir, 'second.jsonl')
    writeFileSync(a, line(0) + line(900))
    writeFileSync(b, line(0) + line(60))
    const first = buildSessionTimeline({ name: 'reused', adapter: 'claude', transcriptPath: a, createdSec: 0 }, 1000)!
    expect(first.t1).toBe(900)
    const second = buildSessionTimeline({ name: 'reused', adapter: 'claude', transcriptPath: b, createdSec: 0 }, 1000)!
    expect(second.t1).toBe(60)
  })

  it('starts over when the file shrinks', () => {
    const p = join(dir, 'rotate.jsonl')
    writeFileSync(p, line(0) + line(900))
    const input = { name: 'rot', adapter: 'claude', transcriptPath: p, createdSec: 0 }
    expect(buildSessionTimeline(input, 1000)!.t1).toBe(900)
    writeFileSync(p, line(30))
    expect(buildSessionTimeline(input, 1000)!.t1).toBe(30)
  })
})

describe('cache bounds', () => {
  it('evicts old sessions rather than growing without limit', () => {
    const p = join(dir, 'shared.jsonl')
    writeFileSync(p, line(0))
    for (let i = 0; i < 40; i++) {
      buildSessionTimeline({ name: `s${i}`, adapter: 'claude', transcriptPath: p, createdSec: 0 }, 1000)
    }
    // Not directly observable, so assert the behaviour that matters: the
    // earliest session still resolves correctly after eviction.
    expect(buildSessionTimeline({ name: 's0', adapter: 'claude', transcriptPath: p, createdSec: 0 }, 1000)!.t1).toBe(0)
  })
})

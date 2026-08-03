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

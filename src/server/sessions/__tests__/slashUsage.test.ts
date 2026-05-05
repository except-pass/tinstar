import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SlashUsage, extractLeadingSlashName } from '../slashUsage'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slash-usage-'))
  file = join(dir, 'usage.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('extractLeadingSlashName', () => {
  it('extracts `/foo`', () => expect(extractLeadingSlashName('/foo bar')).toBe('foo'))
  it('rejects non-leading slash', () => expect(extractLeadingSlashName('hello /foo')).toBeNull())
  it('rejects path-style', () => expect(extractLeadingSlashName('/foo/bar/baz')).toBe('foo'))
  it('returns null for plain text', () => expect(extractLeadingSlashName('hello')).toBeNull())
  it('handles namespaced names', () => expect(extractLeadingSlashName('/superpowers:brainstorming')).toBe('superpowers:brainstorming'))
})

describe('SlashUsage', () => {
  it('starts empty', () => {
    const u = new SlashUsage(file)
    expect(u.snapshot()).toEqual({})
  })
  it('increments and persists', async () => {
    const u = new SlashUsage(file)
    u.increment('foo')
    u.increment('foo')
    u.increment('bar')
    await u.flush()
    expect(existsSync(file)).toBe(true)
    const u2 = new SlashUsage(file)
    expect(u2.snapshot()['foo']!.count).toBe(2)
    expect(u2.snapshot()['bar']!.count).toBe(1)
  })
  it('LRU-evicts at cap', async () => {
    const u = new SlashUsage(file, { cap: 3 })
    u.increment('a'); await delay(2)
    u.increment('b'); await delay(2)
    u.increment('c'); await delay(2)
    u.increment('d')  // pushes 'a' out
    expect(u.snapshot()['a']).toBeUndefined()
    expect(Object.keys(u.snapshot()).sort()).toEqual(['b', 'c', 'd'])
  })
  it('drops corrupt entries on load (negative count, invalid date)', () => {
    writeFileSync(file, JSON.stringify({
      good: { count: 3, lastUsedAt: new Date().toISOString() },
      negCount: { count: -1, lastUsedAt: new Date().toISOString() },
      badDate: { count: 1, lastUsedAt: 'not-a-date' },
      noFields: { count: 1 },
    }))
    const u = new SlashUsage(file)
    const snap = u.snapshot()
    expect(snap['good']).toBeTruthy()
    expect(snap['negCount']).toBeUndefined()
    expect(snap['badDate']).toBeUndefined()
    expect(snap['noFields']).toBeUndefined()
  })
})

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)) }

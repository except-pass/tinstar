// src/lib/__tests__/slashMatching.test.ts
import { describe, it, expect } from 'vitest'
import { findSlashToken } from '../slashMatching'
import { rankCommands, type SlashCommand, type UsageEntry } from '../slashMatching'

describe('findSlashToken', () => {
  it('detects slash at start of string', () => {
    expect(findSlashToken('/foo', 4)).toEqual({ start: 0, partial: 'foo' })
  })
  it('detects slash after a space', () => {
    expect(findSlashToken('please /foo', 11)).toEqual({ start: 7, partial: 'foo' })
  })
  it('detects slash after a newline', () => {
    expect(findSlashToken('hi\n/bar', 7)).toEqual({ start: 3, partial: 'bar' })
  })
  it('returns null for path-like slash (non-whitespace before)', () => {
    expect(findSlashToken('path/to/foo', 11)).toBeNull()
  })
  it('returns null when cursor is before any slash', () => {
    expect(findSlashToken('hello /foo', 3)).toBeNull()
  })
  it('handles empty partial (just typed `/`)', () => {
    expect(findSlashToken('/', 1)).toEqual({ start: 0, partial: '' })
  })
  it('returns null when cursor moves into whitespace after token', () => {
    expect(findSlashToken('/foo bar', 5)).toBeNull()
  })
  it('returns the token even if cursor is mid-token', () => {
    expect(findSlashToken('/foo', 2)).toEqual({ start: 0, partial: 'f' })
  })
})

const cmds: SlashCommand[] = [
  { name: 'full-review',  description: 'review pipeline',     source: 'user' },
  { name: 'flourish-test', description: 'flourish demo',       source: 'user' },
  { name: 'review',        description: 'review pull requests', source: 'user' },
  { name: 'tinstar-commit',description: 'commit with task tag', source: 'user' },
]

describe('rankCommands', () => {
  it('exact name match wins over prefix', () => {
    const out = rankCommands(cmds, 'review', {})
    expect(out[0]!.name).toBe('review')
  })
  it('prefix beats substring', () => {
    const out = rankCommands(cmds, 'full', {})
    expect(out[0]!.name).toBe('full-review')
  })
  it('substring matches when no prefix', () => {
    const out = rankCommands(cmds, 'commit', {})
    expect(out[0]!.name).toBe('tinstar-commit')
  })
  it('description matches with low score', () => {
    const out = rankCommands(cmds, 'pull', {})
    expect(out[0]!.name).toBe('review') // matches "pull requests" in description
  })
  it('empty partial uses recency+frequency only', () => {
    const usage: Record<string, UsageEntry> = {
      'full-review':  { count: 10, lastUsedAt: new Date(Date.now() - 1000).toISOString() },
      'review':       { count: 1,  lastUsedAt: new Date(Date.now() - 90 * 86400_000).toISOString() },
    }
    const out = rankCommands(cmds, '', usage)
    expect(out[0]!.name).toBe('full-review')
  })
  it('caps result list at 5', () => {
    const many: SlashCommand[] = Array.from({ length: 20 }, (_, i) => ({
      name: `cmd-${i}`, description: '', source: 'user',
    }))
    expect(rankCommands(many, 'cmd', {})).toHaveLength(5)
  })
})

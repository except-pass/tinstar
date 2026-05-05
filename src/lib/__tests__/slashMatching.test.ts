// src/lib/__tests__/slashMatching.test.ts
import { describe, it, expect } from 'vitest'
import { findSlashToken } from '../slashMatching'

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

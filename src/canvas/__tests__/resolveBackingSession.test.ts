import { describe, it, expect } from 'vitest'
import { resolveBackingSession } from '../resolveBackingSession'

const ctx = (members: Record<string, string[]>) => ({
  slotsForNode: (n: string) => Object.entries(members).filter(([, ns]) => ns.includes(n)).map(([s]) => s),
  nodesInSlot: (s: string) => members[s] ?? [],
})

describe('resolveBackingSession', () => {
  it('returns the sessionId embedded in a run node id', () => {
    expect(resolveBackingSession('run-abc', ctx({}))).toBe('abc')
  })
  it('finds a run peer sharing a slot', () => {
    expect(resolveBackingSession('browser-x', ctx({ '1': ['browser-x', 'run-sess9'] }))).toBe('sess9')
  })
  it('returns null when no run peer exists', () => {
    expect(resolveBackingSession('image-y', ctx({ '1': ['image-y', 'editor-z'] }))).toBeNull()
  })
  it('returns null for an unslotted non-run node', () => {
    expect(resolveBackingSession('editor-q', ctx({}))).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { buildCoversSummary } from '../covers-summary'
import type { RecapEntry } from '../../../domain/types'

function entry(type: RecapEntry['type'], content: string, toolUses?: number): RecapEntry {
  return { id: Math.random().toString(36).slice(2), type, content, toolUses }
}

describe('buildCoversSummary', () => {
  it('summarizes first ask, last agent turn, and counts', () => {
    const recap: RecapEntry[] = [
      entry('user', 'How should we design the graveyard?'),
      entry('agent', 'We should tombstone on delete.', 3),
      entry('user', 'What about revive?'),
      entry('agent', 'Revive re-materializes from the stored convId.', 2),
    ]
    const s = buildCoversSummary(recap, { task: 'Graveyard' })
    expect(s).toContain('Graveyard')
    expect(s).toContain('How should we design the graveyard?')
    expect(s).toContain('Revive re-materializes from the stored convId.')
    expect(s).toContain('2 turns')
    expect(s).toContain('5 tool uses')
  })

  it('falls back to derived signals when there are no turns (R6)', () => {
    const s = buildCoversSummary([], { task: 'Graveyard', epic: 'Sessions', persona: 'reviewer bot' })
    expect(s).toContain('Graveyard')
    expect(s).toContain('Sessions')
    expect(s).toContain('reviewer bot')
    expect(s).not.toContain('Asked')
  })

  it('degrades gracefully with only status entries', () => {
    const s = buildCoversSummary([entry('status', 'idle')], { sessionName: 'ghost' })
    expect(s).toBe('Session ghost — no recorded activity.')
  })

  it('is deterministic for identical inputs', () => {
    const recap = [entry('user', 'hi'), entry('agent', 'hello', 1)]
    const meta = { task: 'T' }
    expect(buildCoversSummary(recap, meta)).toBe(buildCoversSummary(recap, meta))
  })

  it('clips very long content instead of dumping the whole turn', () => {
    const long = 'x'.repeat(500)
    const s = buildCoversSummary([entry('user', long)], {})
    expect(s.length).toBeLessThan(300)
    expect(s).toContain('…')
  })

  it('uses singular units for a single turn / tool use', () => {
    const s = buildCoversSummary([entry('user', 'q'), entry('agent', 'a', 1)], {})
    expect(s).toContain('1 turn')
    expect(s).not.toContain('1 turns')
    expect(s).toContain('1 tool use')
    expect(s).not.toContain('1 tool uses')
  })
})

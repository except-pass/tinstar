import { describe, it, expect } from 'vitest'
import { markSnapped } from '../createApi'

describe('peer snapped flag', () => {
  it('marks peers that share a snapped edge with me', () => {
    const peers = [{ id: 'run-R1', kind: 'run', capabilities: [] }, { id: 'pw-x', kind: 'plugin', capabilities: [] }]
    const out = markSnapped('pw-self', peers, (id) => id === 'pw-self' ? ['run-R1'] : [])
    expect(out.find(p => p.id === 'run-R1')!.snapped).toBe(true)
    expect(out.find(p => p.id === 'pw-x')!.snapped).toBe(false)
  })
})

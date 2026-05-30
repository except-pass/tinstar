// src/plugins/nats-traffic/src/resolveBinding.test.ts
import { describe, it, expect } from 'vitest'
import { resolveBinding } from './resolveBinding'

const run = (id: string, snapped: boolean) => ({ id, kind: 'run', capabilities: [], snapped })
const pw  = (id: string, snapped: boolean) => ({ id, kind: 'plugin', capabilities: [], snapped })

describe('resolveBinding', () => {
  it('no constellation → all-traffic', () => {
    expect(resolveBinding({ inConstellation: false, peers: [] })).toEqual({ mode: 'all' })
  })
  it('snapped directly to a run → that run', () => {
    const r = resolveBinding({ inConstellation: true, peers: [run('run-R1', true), pw('pw-x', false)] })
    expect(r).toEqual({ mode: 'runs', runIds: ['run-R1'] })
  })
  it('snapped to multiple runs → union', () => {
    const r = resolveBinding({ inConstellation: true, peers: [run('run-R1', true), run('run-R2', true)] })
    expect(r).toEqual({ mode: 'runs', runIds: ['run-R1', 'run-R2'] })
  })
  it('in a group with runs but none snapped → whole-constellation union', () => {
    const r = resolveBinding({ inConstellation: true, peers: [run('run-R1', false), run('run-R2', false), pw('pw-x', true)] })
    expect(r).toEqual({ mode: 'runs', runIds: ['run-R1', 'run-R2'] })
  })
  it('in a group with no runs → empty', () => {
    expect(resolveBinding({ inConstellation: true, peers: [pw('pw-x', true)] })).toEqual({ mode: 'empty' })
  })
})

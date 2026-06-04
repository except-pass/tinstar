import { describe, it, expect } from 'vitest'
import { resolveRunViewType } from '../runView'

const reg = (types: string[]) => (t: string) => types.includes(t)

describe('resolveRunViewType', () => {
  it('defaults to run-workspace when view is absent', () => {
    expect(resolveRunViewType({ view: undefined }, reg(['run-workspace']))).toBe('run-workspace')
  })
  it('uses run.view when set and registered', () => {
    expect(resolveRunViewType({ view: 'roborev-cockpit' }, reg(['run-workspace', 'roborev-cockpit']))).toBe('roborev-cockpit')
  })
  it('falls back to run-workspace when run.view is set but NOT registered (plugin disabled)', () => {
    expect(resolveRunViewType({ view: 'roborev-cockpit' }, reg(['run-workspace']))).toBe('run-workspace')
  })
})

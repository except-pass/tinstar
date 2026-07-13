import { describe, it, expect } from 'vitest'
import { normalizeRunName, runDisplayName, RUN_NAME_MAX } from '../runName'

describe('normalizeRunName', () => {
  it('keeps free text verbatim — it is not the id sanitizer', () => {
    expect(normalizeRunName('PM: Vpp project (Q3)')).toBe('PM: Vpp project (Q3)')
  })

  it('preserves multibyte characters', () => {
    expect(normalizeRunName('⚡ Проект — café 🔋')).toBe('⚡ Проект — café 🔋')
  })

  it('trims surrounding whitespace', () => {
    expect(normalizeRunName('  PM Vpp project  ')).toBe('PM Vpp project')
  })

  it('collapses every "no name" input to undefined', () => {
    // One unambiguous absent-value, so nothing downstream has to decide whether
    // '' means "named the empty string" or "not named".
    expect(normalizeRunName('')).toBeUndefined()
    expect(normalizeRunName('   ')).toBeUndefined()
    expect(normalizeRunName(null)).toBeUndefined()
    expect(normalizeRunName(undefined)).toBeUndefined()
  })

  it('returns undefined for non-strings rather than coercing', () => {
    expect(normalizeRunName(42)).toBeUndefined()
    expect(normalizeRunName({})).toBeUndefined()
  })

  it('caps a pathologically long name', () => {
    expect(normalizeRunName('x'.repeat(500))).toHaveLength(RUN_NAME_MAX)
  })
})

describe('runDisplayName', () => {
  it('prefers the friendly name', () => {
    expect(runDisplayName({ id: 'vpppm-general-pourpose-2dc86', name: 'PM Vpp project' })).toBe('PM Vpp project')
  })

  it('falls back to the id when there is no name', () => {
    expect(runDisplayName({ id: 'vpppm-general-pourpose-2dc86' })).toBe('vpppm-general-pourpose-2dc86')
  })

  it('falls back to the id for an empty-string name, never rendering blank', () => {
    // The `||` vs `??` trap: a cleared input yields '', and `??` would treat it
    // as present and render an empty label.
    expect(runDisplayName({ id: 'vpppm-general-pourpose-2dc86', name: '' })).toBe('vpppm-general-pourpose-2dc86')
  })
})

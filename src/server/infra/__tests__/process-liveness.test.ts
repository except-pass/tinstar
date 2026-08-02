import { describe, expect, it } from 'vitest'
import {
  isSupportedProcessId,
  probeProcessLiveness,
} from '../process-liveness'

describe('process liveness', () => {
  it.each([
    [0, false],
    [-1, false],
    [42.5, false],
    [Number.NaN, false],
    ['42', false],
    [1, true],
    [0x7fff_ffff, true],
    [0x8000_0000, false],
    [Number.MAX_SAFE_INTEGER, false],
  ])('validates supported process id %s', (pid, expected) => {
    expect(isSupportedProcessId(pid)).toBe(expected)
  })

  it('classifies an unsupported pid without invoking the OS', () => {
    expect(probeProcessLiveness(Number.MAX_SAFE_INTEGER)).toEqual({
      state: 'invalid',
      reason: `unsupported process id ${Number.MAX_SAFE_INTEGER}`,
    })
  })

  it('recognizes the current process as alive', () => {
    expect(probeProcessLiveness(process.pid)).toEqual({ state: 'alive' })
  })
})

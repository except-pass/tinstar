import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isSupportedProcessId,
  probeProcessLiveness,
} from '../process-liveness'

describe('process liveness', () => {
  afterEach(() => vi.restoreAllMocks())

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

  it('recognizes ESRCH as proof that a process is gone', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })

    expect(probeProcessLiveness(42)).toEqual({ state: 'gone' })
  })

  it('preserves EPERM as structured unknown liveness', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })

    expect(probeProcessLiveness(42)).toEqual({
      state: 'unknown',
      code: 'EPERM',
      reason: 'process probe failed with EPERM',
    })
  })

  it('keeps code-less probe failures unknown', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => { throw new TypeError('unexpected failure') })

    expect(probeProcessLiveness(42)).toEqual({
      state: 'unknown',
      reason: 'process probe failed without an OS error code',
    })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  compareProcessIdentity,
  isSupportedProcessId,
  linuxProcessIdentity,
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

  it('safely describes a symbol pid as invalid without invoking the OS', () => {
    const kill = vi.spyOn(process, 'kill')

    expect(probeProcessLiveness(Symbol('pid'))).toEqual({
      state: 'invalid',
      reason: 'unsupported process id Symbol(pid)',
    })
    expect(kill).not.toHaveBeenCalled()
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

  it('derives a boot-scoped Linux identity from field 22 after a complex comm', () => {
    const fieldsThreeThroughTwentyTwo = [
      'S', '1', '2', '3', '4', '5', '6', '7', '8', '9',
      '10', '11', '12', '13', '14', '15', '16', '17', '18', '424242',
    ]
    const stat = `42 (worker ) with spaces) ${fieldsThreeThroughTwentyTwo.join(' ')}`

    expect(linuxProcessIdentity(stat, 'boot-a\n')).toBe('linux:boot-a:424242')
    expect(linuxProcessIdentity(stat, 'boot-b\n')).toBe('linux:boot-b:424242')
  })

  it('does not treat a pre-boot-id Linux token as proof of pid replacement', () => {
    expect(compareProcessIdentity('linux:424242', 'linux:boot-a:424242'))
      .toBe('legacy-unscoped')
    expect(compareProcessIdentity('linux:123456', 'linux:boot-a:424242'))
      .toBe('different')
    expect(compareProcessIdentity('linux:boot-a:424242', 'linux:boot-b:424242'))
      .toBe('different')
    expect(compareProcessIdentity('linux:boot-a:424242', 'linux:boot-a:424242'))
      .toBe('same')
  })
})

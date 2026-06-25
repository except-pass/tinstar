import { describe, it, expect } from 'vitest'
import { fmtNum, fmtDollar, fmtRate } from '../fmt'

describe('fmtNum', () => {
  it('returns "0" for zero', () => {
    expect(fmtNum(0)).toBe('0')
  })

  it('returns plain number for values under 1000', () => {
    expect(fmtNum(42)).toBe('42')
    expect(fmtNum(999)).toBe('999')
  })

  it('formats thousands with k suffix', () => {
    expect(fmtNum(1000)).toBe('1.0k')
    expect(fmtNum(1500)).toBe('1.5k')
    expect(fmtNum(45600)).toBe('45.6k')
  })

  it('formats millions with M suffix', () => {
    expect(fmtNum(1_000_000)).toBe('1.0M')
    expect(fmtNum(2_500_000)).toBe('2.5M')
  })

  it('formats billions with B suffix', () => {
    expect(fmtNum(1_000_000_000)).toBe('1.0B')
  })

  it('formats trillions with T suffix', () => {
    expect(fmtNum(1_000_000_000_000)).toBe('1.0T')
  })

  it('handles negative numbers', () => {
    expect(fmtNum(-5000)).toBe('-5.0k')
  })

  it('rounds small numbers', () => {
    expect(fmtNum(3.7)).toBe('4')
  })
})

describe('fmtDollar', () => {
  it('formats dollar amounts with two decimal places', () => {
    expect(fmtDollar(1.5)).toBe('$1.50')
    expect(fmtDollar(0.99)).toBe('$0.99')
    expect(fmtDollar(100)).toBe('$100.00')
  })

  it('handles sub-dollar amounts', () => {
    expect(fmtDollar(0.05)).toBe('$0.05')
  })

  it('handles negative amounts', () => {
    expect(fmtDollar(-2.5)).toBe('$-2.50')
  })

  it('handles zero', () => {
    expect(fmtDollar(0)).toBe('$0.00')
  })
})

describe('fmtRate', () => {
  it('delegates to fmtNum after rounding', () => {
    expect(fmtRate(1234.7)).toBe('1.2k')
    expect(fmtRate(42.3)).toBe('42')
  })

  it('returns "0" for zero', () => {
    expect(fmtRate(0)).toBe('0')
  })
})

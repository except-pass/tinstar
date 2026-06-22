import { describe, it, expect, afterEach } from 'vitest'
import { registerPinCapture, unregisterPinCapture, getPinCapture } from '../captureRegistry'

afterEach(() => {
  unregisterPinCapture('node-a')
  unregisterPinCapture('node-b')
})

describe('captureRegistry', () => {
  it('returns undefined for an unregistered node', () => {
    expect(getPinCapture('node-a')).toBeUndefined()
  })

  it('register/get returns the registered fn, which receives the point', () => {
    const fn = (pt: { clientX: number; clientY: number }) => ({ at: pt.clientX + pt.clientY })
    registerPinCapture('node-a', fn)
    const got = getPinCapture('node-a')
    expect(got).toBe(fn)
    expect(got!({ clientX: 3, clientY: 4 })).toEqual({ at: 7 })
  })

  it('is per-node — registering one node does not affect another', () => {
    registerPinCapture('node-a', () => ({ which: 'a' }))
    expect(getPinCapture('node-b')).toBeUndefined()
    expect(getPinCapture('node-a')!({ clientX: 0, clientY: 0 })).toEqual({ which: 'a' })
  })

  it('re-registering replaces the prior fn', () => {
    registerPinCapture('node-a', () => ({ v: 1 }))
    registerPinCapture('node-a', () => ({ v: 2 }))
    expect(getPinCapture('node-a')!({ clientX: 0, clientY: 0 })).toEqual({ v: 2 })
  })

  it('unregister removes the fn', () => {
    registerPinCapture('node-a', () => ({}))
    unregisterPinCapture('node-a')
    expect(getPinCapture('node-a')).toBeUndefined()
  })
})

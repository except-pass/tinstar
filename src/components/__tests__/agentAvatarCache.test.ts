import { describe, it, expect, beforeEach } from 'vitest'
import { getAvatarDataUrl, __resetAvatarCacheForTests } from '../agentAvatarCache'

// Polyfill btoa for Node environment (safe no-op if already defined).
if (typeof globalThis.btoa === 'undefined') {
  // @ts-ignore
  globalThis.btoa = (s: string) => Buffer.from(s, 'binary').toString('base64')
}

describe('agentAvatarCache', () => {
  beforeEach(() => {
    __resetAvatarCacheForTests()
  })

  it('returns null immediately on first call, then resolves', async () => {
    const sync = getAvatarDataUrl('seed-a', '#ff0000')
    expect(sync).toBeNull()
    // Wait a tick for the dynamic import + render to resolve.
    await new Promise(r => setTimeout(r, 200))
    const cached = getAvatarDataUrl('seed-a', '#ff0000')
    expect(typeof cached).toBe('string')
    expect(cached!.startsWith('data:image/svg+xml')).toBe(true)
  })

  it('returns the same data URL for the same seed+color', async () => {
    getAvatarDataUrl('seed-b', '#00ff00')
    await new Promise(r => setTimeout(r, 200))
    const first = getAvatarDataUrl('seed-b', '#00ff00')
    const second = getAvatarDataUrl('seed-b', '#00ff00')
    expect(first).toBe(second)
  })

  it('produces distinct SVGs for distinct seeds', async () => {
    getAvatarDataUrl('seed-c', '#0000ff')
    getAvatarDataUrl('seed-d', '#0000ff')
    await new Promise(r => setTimeout(r, 200))
    const c = getAvatarDataUrl('seed-c', '#0000ff')
    const d = getAvatarDataUrl('seed-d', '#0000ff')
    expect(c).not.toBe(d)
  })
})

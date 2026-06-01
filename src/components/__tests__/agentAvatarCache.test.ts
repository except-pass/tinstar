import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getAvatarDataUrl, __resetAvatarCacheForTests } from '../agentAvatarCache'

/**
 * Poll getAvatarDataUrl until the DiceBear dynamic import resolves and the cache fills.
 * The cache is reset per-test, so every test re-pays the cold-import cost — a fixed sleep
 * is flaky on slow/cold CI runners. Polls instead, with a generous ceiling.
 */
function waitForAvatar(seed: string, color: string): Promise<string> {
  return vi.waitFor(() => {
    const v = getAvatarDataUrl(seed, color)
    if (typeof v !== 'string') throw new Error('avatar not ready')
    return v
  }, { timeout: 4000, interval: 20 })
}

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
    const cached = await waitForAvatar('seed-a', '#ff0000')
    expect(cached.startsWith('data:image/svg+xml')).toBe(true)
  })

  it('returns the same data URL for the same seed+color', async () => {
    const first = await waitForAvatar('seed-b', '#00ff00')
    const second = getAvatarDataUrl('seed-b', '#00ff00')
    expect(first).toBe(second)
  })

  it('produces distinct SVGs for distinct seeds', async () => {
    const c = await waitForAvatar('seed-c', '#0000ff')
    const d = await waitForAvatar('seed-d', '#0000ff')
    expect(c).not.toBe(d)
  })
})

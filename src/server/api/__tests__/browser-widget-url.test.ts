import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isTinstarSelfEmbedUrl, TINSTAR_SELF_EMBED_MESSAGE } from '../browser-widget-url'
import {
  registerReachOrigin,
  resetOriginAllowlistForTests,
  unregisterReachOrigin,
} from '../originAllowlist'

describe('isTinstarSelfEmbedUrl — the reach origin counts as self', () => {
  afterEach(() => { resetOriginAllowlistForTests() })

  it('recognizes a registered reach URL as the dashboard', () => {
    // A reach URL is this same dashboard under another name, so nesting it in a
    // browser widget recurses exactly as a loopback URL would. Without this the
    // guard is silently absent for the remote case it exists for.
    expect(isTinstarSelfEmbedUrl('https://host.tailnet.ts.net/')).toBe(false)
    registerReachOrigin('https://host.tailnet.ts.net')
    expect(isTinstarSelfEmbedUrl('https://host.tailnet.ts.net/')).toBe(true)
  })

  it('still exempts the artifact endpoint on the reach origin', () => {
    registerReachOrigin('https://host.tailnet.ts.net')
    expect(isTinstarSelfEmbedUrl('https://host.tailnet.ts.net/api/artifacts/abc')).toBe(false)
  })

  it('stops recognizing it once reach is revoked', () => {
    registerReachOrigin('https://host.tailnet.ts.net')
    unregisterReachOrigin('https://host.tailnet.ts.net')
    expect(isTinstarSelfEmbedUrl('https://host.tailnet.ts.net/')).toBe(false)
  })
})

describe('isTinstarSelfEmbedUrl', () => {
  const env = process.env

  beforeEach(() => {
    delete process.env.TINSTAR_DASHBOARD_URL
    delete process.env.TINSTAR_DASHBOARD_PORT
    delete process.env.TINSTAR_BACKEND_PORT
  })

  afterEach(() => {
    process.env = env
  })

  it('blocks default standalone and dev ports on localhost', () => {
    expect(isTinstarSelfEmbedUrl('http://localhost:5273')).toBe(true)
    expect(isTinstarSelfEmbedUrl('http://localhost:5280/')).toBe(true)
    expect(isTinstarSelfEmbedUrl('http://127.0.0.1:5273/api/state')).toBe(true)
  })

  it('allows external URLs and stretchplan', () => {
    expect(isTinstarSelfEmbedUrl('http://localhost:8932/p/my-plan')).toBe(false)
    expect(isTinstarSelfEmbedUrl('http://localhost:3000')).toBe(false)
    expect(isTinstarSelfEmbedUrl('')).toBe(false)
  })

  it('allows Tinstar artifact URLs', () => {
    expect(isTinstarSelfEmbedUrl('http://localhost:5273/api/artifacts/eph-123')).toBe(false)
    expect(isTinstarSelfEmbedUrl('http://127.0.0.1:5273/api/artifacts/eph-123?v=2')).toBe(false)
  })

  it('honors TINSTAR_DASHBOARD_URL origin', () => {
    process.env.TINSTAR_DASHBOARD_URL = 'http://100.108.201.76:5273'
    expect(isTinstarSelfEmbedUrl('http://100.108.201.76:5273/')).toBe(true)
    expect(isTinstarSelfEmbedUrl('http://localhost:5273')).toBe(true)
  })

  it('honors TINSTAR_DASHBOARD_PORT override', () => {
    process.env.TINSTAR_DASHBOARD_PORT = '5999'
    expect(isTinstarSelfEmbedUrl('http://localhost:5999')).toBe(true)
    expect(isTinstarSelfEmbedUrl('http://localhost:5273')).toBe(true)
  })
})

describe('TINSTAR_SELF_EMBED_MESSAGE', () => {
  it('mentions stretchplan path shape', () => {
    expect(TINSTAR_SELF_EMBED_MESSAGE).toContain('8932/p/')
  })
})

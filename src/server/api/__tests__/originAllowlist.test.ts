import { beforeEach, describe, expect, it } from 'vitest'
import { resolveCorsHeaders } from '../cors'
import {
  DESKTOP_APP_ORIGINS,
  currentOriginAllowlist,
  sessionUpgradeOrigins,
  registerReachOrigin,
  resetOriginAllowlistForTests,
  seedOriginAllowlist,
  unregisterReachOrigin,
} from '../originAllowlist'

beforeEach(() => {
  resetOriginAllowlistForTests()
  delete process.env.TINSTAR_CORS_ORIGINS
})

function headersFor(origin: string) {
  return resolveCorsHeaders({ origin, allowlist: currentOriginAllowlist() })
}

describe('origin allowlist — the wildcard is gone on a fresh install', () => {
  it('is never empty once seeded, so an unknown origin gets no allow-origin', () => {
    // The state this plan actually ships FIRST is containment without reach.
    // An empty allowlist there hands `Access-Control-Allow-Origin: *` to any
    // page the operator happens to visit, which can then read the whole canvas
    // API. Seeding is what makes that branch unreachable.
    seedOriginAllowlist(5273)

    expect(currentOriginAllowlist().length).toBeGreaterThan(0)
    expect(headersFor('http://evil.example')['Access-Control-Allow-Origin'])
      .toBeUndefined()
  })

  it('admits the server\'s own loopback origins', () => {
    seedOriginAllowlist(5273)

    for (const origin of [
      'http://localhost:5273',
      'http://127.0.0.1:5273',
      'http://[::1]:5273',
    ]) {
      expect(headersFor(origin)['Access-Control-Allow-Origin']).toBe(origin)
    }
  })

  it('admits the desktop app', () => {
    seedOriginAllowlist(5273)

    for (const origin of DESKTOP_APP_ORIGINS) {
      expect(headersFor(origin)['Access-Control-Allow-Origin']).toBe(origin)
    }
  })

  it('seeds the port that actually bound', () => {
    seedOriginAllowlist(5281)

    expect(headersFor('http://localhost:5281')['Access-Control-Allow-Origin'])
      .toBe('http://localhost:5281')
    expect(headersFor('http://localhost:5273')['Access-Control-Allow-Origin'])
      .toBeUndefined()
  })
})

describe('origin allowlist — reach registration', () => {
  it('gives a registered origin an explicit allow plus credentials', () => {
    seedOriginAllowlist(5273)
    registerReachOrigin('https://host.tailnet.ts.net')

    const headers = headersFor('https://host.tailnet.ts.net')
    expect(headers['Access-Control-Allow-Origin']).toBe('https://host.tailnet.ts.net')
    expect(headers['Access-Control-Allow-Credentials']).toBe('true')
    expect(headers.Vary).toBe('Origin')
  })

  it('gives an unregistered origin neither', () => {
    seedOriginAllowlist(5273)
    registerReachOrigin('https://host.tailnet.ts.net')

    const headers = headersFor('https://other.tailnet.ts.net')
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined()
    expect(headers['Access-Control-Allow-Credentials']).toBeUndefined()
  })

  it('does not strip the desktop app when the first reach origin registers', () => {
    // The trap: before seeding, registering the first origin flipped the
    // allowlist from empty (wildcard, everyone allowed) to one entry, silently
    // narrowing the response for every other caller including the desktop app.
    seedOriginAllowlist(5273)
    registerReachOrigin('https://host.tailnet.ts.net')

    expect(headersFor('tauri://localhost')['Access-Control-Allow-Origin'])
      .toBe('tauri://localhost')
  })

  it('restores the prior behaviour for an origin once unregistered', () => {
    seedOriginAllowlist(5273)
    registerReachOrigin('https://host.tailnet.ts.net')
    unregisterReachOrigin('https://host.tailnet.ts.net')

    expect(headersFor('https://host.tailnet.ts.net')['Access-Control-Allow-Origin'])
      .toBeUndefined()
  })

  it('returns to the seeded set — never to an empty allowlist — after the last unregister', () => {
    // An empty allowlist is the wildcard branch. Revoking reach must not be a
    // way back into it.
    seedOriginAllowlist(5273)
    registerReachOrigin('https://host.tailnet.ts.net')
    unregisterReachOrigin('https://host.tailnet.ts.net')

    expect(currentOriginAllowlist().length).toBeGreaterThan(0)
    expect(headersFor('http://evil.example')['Access-Control-Allow-Origin'])
      .toBeUndefined()
    expect(headersFor('http://localhost:5273')['Access-Control-Allow-Origin'])
      .toBe('http://localhost:5273')
  })

  it('normalizes a trailing slash so a registration cannot silently miss', () => {
    seedOriginAllowlist(5273)
    registerReachOrigin('https://host.tailnet.ts.net/')

    expect(headersFor('https://host.tailnet.ts.net')['Access-Control-Allow-Origin'])
      .toBe('https://host.tailnet.ts.net')
  })
})

describe('origin allowlist — the environment allowlist still counts', () => {
  it('coexists with seeded and registered origins', () => {
    process.env.TINSTAR_CORS_ORIGINS = 'https://configured.example'
    seedOriginAllowlist(5273)
    registerReachOrigin('https://host.tailnet.ts.net')

    for (const origin of [
      'https://configured.example',
      'https://host.tailnet.ts.net',
      'http://localhost:5273',
    ]) {
      expect(headersFor(origin)['Access-Control-Allow-Origin']).toBe(origin)
    }
  })

  it('is read fresh, not captured at first call', () => {
    seedOriginAllowlist(5273)
    expect(headersFor('https://late.example')['Access-Control-Allow-Origin'])
      .toBeUndefined()

    process.env.TINSTAR_CORS_ORIGINS = 'https://late.example'
    expect(headersFor('https://late.example')['Access-Control-Allow-Origin'])
      .toBe('https://late.example')
  })
})

describe('sessionUpgradeOrigins — the set the terminal upgrade gate reads', () => {
  it('admits the loopback origins for the bound port', () => {
    seedOriginAllowlist(5273)
    for (const origin of [
      'http://localhost:5273',
      'http://127.0.0.1:5273',
      'http://[::1]:5273',
    ]) {
      expect(sessionUpgradeOrigins(5273)).toContain(origin)
    }
  })

  it('admits a registered reach origin', () => {
    // THE BUG THIS EXISTS FOR: reach registered its origin for CORS, but the
    // WebSocket upgrade gate read a different, loopback-only list. The canvas
    // loaded over the tailnet and every terminal upgrade was refused.
    seedOriginAllowlist(5273)
    registerReachOrigin('https://host.tailnet.ts.net')

    expect(sessionUpgradeOrigins(5273)).toContain('https://host.tailnet.ts.net')
  })

  it('stops admitting it once reach is revoked', () => {
    seedOriginAllowlist(5273)
    registerReachOrigin('https://host.tailnet.ts.net')
    unregisterReachOrigin('https://host.tailnet.ts.net')

    expect(sessionUpgradeOrigins(5273)).not.toContain('https://host.tailnet.ts.net')
  })

  it('never admits an unknown origin', () => {
    seedOriginAllowlist(5273)
    registerReachOrigin('https://host.tailnet.ts.net')

    expect(sessionUpgradeOrigins(5273)).not.toContain('http://evil.example')
  })

  it('keeps loopback working before the allowlist has been seeded', () => {
    // The dev-server backend never calls seedOriginAllowlist, and there is a
    // window at boot before the standalone server does.
    expect(sessionUpgradeOrigins(5273)).toContain('http://localhost:5273')
  })
})

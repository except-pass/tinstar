import { describe, it, expect } from 'vitest'
import { resolveCorsHeaders } from '../../src/server/api/cors'

describe('resolveCorsHeaders', () => {
  it('returns wildcard when no allowlist configured', () => {
    const h = resolveCorsHeaders({ origin: 'http://anything', allowlist: [] })
    expect(h['Access-Control-Allow-Origin']).toBe('*')
    expect(h['Access-Control-Allow-Credentials']).toBeUndefined()
  })

  it('echoes origin and sets credentials true when origin is allowlisted', () => {
    const h = resolveCorsHeaders({
      origin: 'http://tailscale-host:5273',
      allowlist: ['http://tailscale-host:5273', 'tauri://localhost'],
    })
    expect(h['Access-Control-Allow-Origin']).toBe('http://tailscale-host:5273')
    expect(h['Access-Control-Allow-Credentials']).toBe('true')
  })

  it('returns null Allow-Origin for disallowed origin when allowlist is set', () => {
    const h = resolveCorsHeaders({
      origin: 'http://evil.example',
      allowlist: ['http://tailscale-host:5273'],
    })
    expect(h['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('treats undefined origin (same-origin / curl) as allowed passthrough', () => {
    const h = resolveCorsHeaders({
      origin: undefined,
      allowlist: ['http://tailscale-host:5273'],
    })
    expect(h['Access-Control-Allow-Origin']).toBeUndefined()
  })
})

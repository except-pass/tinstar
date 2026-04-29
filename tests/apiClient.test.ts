import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { apiUrl, apiFetch, _resetApiBaseForTests } from '../src/apiClient'

describe('apiClient', () => {
  beforeEach(() => {
    _resetApiBaseForTests()
    // default: no injected base, same-origin
    delete (globalThis as any).__TINSTAR_API_BASE__
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns same-origin URL when no base is set', () => {
    expect(apiUrl('/api/commits')).toBe('/api/commits')
  })

  it('prepends runtime-injected base when set', () => {
    ;(globalThis as any).__TINSTAR_API_BASE__ = 'http://ec2.example:5273'
    _resetApiBaseForTests()
    expect(apiUrl('/api/commits')).toBe('http://ec2.example:5273/api/commits')
  })

  it('strips trailing slash from base', () => {
    ;(globalThis as any).__TINSTAR_API_BASE__ = 'http://ec2.example:5273/'
    _resetApiBaseForTests()
    expect(apiUrl('/api/commits')).toBe('http://ec2.example:5273/api/commits')
  })

  it('handles relative paths without leading slash', () => {
    ;(globalThis as any).__TINSTAR_API_BASE__ = 'http://ec2.example:5273'
    _resetApiBaseForTests()
    expect(apiUrl('api/commits')).toBe('http://ec2.example:5273/api/commits')
  })

  it('apiFetch delegates to fetch with resolved URL and credentials', async () => {
    ;(globalThis as any).__TINSTAR_API_BASE__ = 'http://ec2.example:5273'
    _resetApiBaseForTests()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    await apiFetch('/api/commits', { method: 'POST' })
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://ec2.example:5273/api/commits',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    )
  })

  it('apiFetch preserves user-supplied credentials option', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'))
    await apiFetch('/api/commits', { credentials: 'omit' })
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/commits',
      expect.objectContaining({ credentials: 'omit' }),
    )
  })

  it('reads base from window.__TINSTAR_API_BASE__ too (Tauri injection path)', () => {
    ;(globalThis as any).window = globalThis
    ;(globalThis as any).__TINSTAR_API_BASE__ = 'http://tailscale-host:5273'
    _resetApiBaseForTests()
    expect(apiUrl('/api/foo')).toBe('http://tailscale-host:5273/api/foo')
  })
})

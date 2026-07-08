import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isTinstarSelfEmbedUrl, TINSTAR_SELF_EMBED_MESSAGE } from '../browser-widget-url'

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

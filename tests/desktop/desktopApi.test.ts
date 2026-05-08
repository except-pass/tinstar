import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('desktopApi', () => {
  beforeEach(() => {
    vi.resetModules()
    delete (globalThis as any).__TAURI_INTERNALS__
    delete (globalThis as any).__TINSTAR_API_BASE__
  })

  it('exposes undefined capabilities outside Tauri', async () => {
    const { desktopApi } = await import('../../src/desktop/desktopApi')
    expect(desktopApi.getConfig).toBeUndefined()
    expect(desktopApi.saveConfig).toBeUndefined()
    expect(desktopApi.openDirectoryDialog).toBeUndefined()
  })

  it('exposes function capabilities inside Tauri', async () => {
    ;(globalThis as any).__TAURI_INTERNALS__ = { invoke: vi.fn() }
    const { desktopApi } = await import('../../src/desktop/desktopApi')
    expect(typeof desktopApi.getConfig).toBe('function')
    expect(typeof desktopApi.saveConfig).toBe('function')
    expect(typeof desktopApi.openDirectoryDialog).toBe('function')
  })
})

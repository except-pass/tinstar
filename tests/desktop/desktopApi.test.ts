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

  it('saveConfig calls invoke with command="save_config" and arg key="cfg"', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    ;(globalThis as any).__TAURI_INTERNALS__ = { invoke: vi.fn() }

    const { desktopApi } = await import('../../src/desktop/desktopApi')
    const cfg = {
      backend: { mode: 'remote' as const, url: 'http://x:5273' },
    }
    await desktopApi.saveConfig!(cfg)

    expect(invoke).toHaveBeenCalledWith('save_config', { cfg })

    vi.doUnmock('@tauri-apps/api/core')
  })

  it('probeBackend calls invoke with command="probe_backend" and arg key="url"', async () => {
    const invoke = vi.fn().mockResolvedValue(true)
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }))
    ;(globalThis as any).__TAURI_INTERNALS__ = { invoke: vi.fn() }

    const { desktopApi } = await import('../../src/desktop/desktopApi')
    await desktopApi.probeBackend!('http://x:5273')

    expect(invoke).toHaveBeenCalledWith('probe_backend', { url: 'http://x:5273' })

    vi.doUnmock('@tauri-apps/api/core')
  })
})

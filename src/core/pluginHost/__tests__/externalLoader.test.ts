import { describe, it, expect, vi } from 'vitest'
import type { Plugin } from '@tinstar/plugin-api'
import { bootExternalPlugins } from '../externalLoader'
import { PluginRegistry } from '../registry'

describe('bootExternalPlugins', () => {
  it('skips when external config is empty', async () => {
    const reg = new PluginRegistry()
    await bootExternalPlugins({ disabled: [], external: [] }, reg, async () => { throw new Error('unreachable') })
    expect(reg.list()).toEqual([])
  })

  it('loads a plugin via the provided importFn and activates it', async () => {
    const reg = new PluginRegistry()
    const fakeModule: Plugin = {
      activate: (api) => {
        api.logger.info('papershore activate')
        return []
      },
    }
    const fakePkg = { name: 'papershore', version: '0.3.0', tinstar: { apiVersion: '5', displayName: 'Papershore' } }

    const importFn = vi.fn().mockResolvedValue({ module: fakeModule, pkg: fakePkg })
    await bootExternalPlugins(
      { disabled: [], external: [{ name: 'papershore', path: '/abs/path' }] },
      reg,
      importFn,
    )
    expect(importFn).toHaveBeenCalledWith({ name: 'papershore', path: '/abs/path' })
    expect(reg.get('papershore')?.state).toBe('active')
  })

  it('skips on importFn rejection but continues to next entry', async () => {
    const reg = new PluginRegistry()
    const fakeModule: Plugin = { activate: () => [] }
    const fakePkg = { name: 'ok', version: '0.1.0', tinstar: { apiVersion: '5', displayName: 'OK' } }
    const importFn = vi.fn()
      .mockRejectedValueOnce(new Error('import-boom'))
      .mockResolvedValueOnce({ module: fakeModule, pkg: fakePkg })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await bootExternalPlugins(
      { disabled: [], external: [
        { name: 'broken', path: '/abs' },
        { name: 'ok', path: '/abs2' },
      ] },
      reg,
      importFn,
    )
    expect(err).toHaveBeenCalled()
    expect(reg.get('broken')).toBeUndefined()
    expect(reg.get('ok')?.state).toBe('active')
    err.mockRestore()
  })

  it('skips entries whose name appears in disabled[]', async () => {
    const reg = new PluginRegistry()
    const importFn = vi.fn()
    await bootExternalPlugins(
      { disabled: ['papershore'], external: [{ name: 'papershore', path: '/abs' }] },
      reg,
      importFn,
    )
    expect(importFn).not.toHaveBeenCalled()
    expect(reg.get('papershore')).toBeUndefined()
  })
})

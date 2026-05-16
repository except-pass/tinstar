import { describe, it, expect, vi } from 'vitest'
import type { Plugin } from '@tinstar/plugin-api'
import { bootBundledPlugins } from '../loader'
import { PluginRegistry } from '../registry'

function fakeBundle(
  name: string,
  opts: { apiVersion?: string; throws?: boolean; disposable?: () => void } = {},
) {
  const plugin: Plugin = {
    activate: () => {
      if (opts.throws) throw new Error('boom')
      return opts.disposable ? [{ dispose: opts.disposable }] : []
    },
  }
  return {
    pkg: {
      name,
      version: '0.1.0',
      tinstar: {
        apiVersion: opts.apiVersion ?? '5',
        displayName: name,
      },
    },
    module: plugin,
  }
}

describe('bootBundledPlugins', () => {
  it('activates every plugin in the bundled index', async () => {
    const reg = new PluginRegistry()
    const bundle = { alpha: fakeBundle('alpha'), beta: fakeBundle('beta') }
    await bootBundledPlugins(bundle, reg)
    expect(reg.get('alpha')?.state).toBe('active')
    expect(reg.get('beta')?.state).toBe('active')
  })

  it('skips plugins with apiVersion mismatch (record absent from registry)', async () => {
    const reg = new PluginRegistry()
    const bundle = { gamma: fakeBundle('gamma', { apiVersion: '4' }) }
    await bootBundledPlugins(bundle, reg)
    // Note: parseManifest throws on apiVersion mismatch BEFORE registry.activate is called.
    // The loader should catch that throw and surface it. The expected outcome is that
    // 'gamma' is either marked failed in the registry OR absent from it — depending on
    // how the loader handles pre-activation manifest errors. The plan's implementation
    // logs the error and skips entirely (no record created).
    expect(reg.get('gamma')).toBeUndefined()
  })

  it('continues activating other plugins when one throws during activate', async () => {
    const reg = new PluginRegistry()
    const bundle = {
      good:  fakeBundle('good'),
      crash: fakeBundle('crash', { throws: true }),
      also:  fakeBundle('also'),
    }
    await bootBundledPlugins(bundle, reg)
    expect(reg.get('good')?.state).toBe('active')
    expect(reg.get('crash')?.state).toBe('failed')
    expect(reg.get('also')?.state).toBe('active')
  })

  it('skips entries with malformed package.json', async () => {
    const reg = new PluginRegistry()
    const bundle = {
      bad: { pkg: { name: 'bad' /* no version, no tinstar */ }, module: { activate: () => [] } },
      ok:  fakeBundle('ok'),
    }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await bootBundledPlugins(bundle, reg)
    expect(reg.get('ok')?.state).toBe('active')
    // 'bad' is not in registry because manifest parsing rejected it before activate
    expect(reg.get('bad')).toBeUndefined()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

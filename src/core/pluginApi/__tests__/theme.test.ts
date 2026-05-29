import { describe, it, expect } from 'vitest'
import type { PluginRecord } from '../../pluginHost/registry'
import type { PluginManifest } from '@tinstar/plugin-api'
import { createPluginApi } from '../createApi'

function makeRecord(name = 'test-plugin'): PluginRecord {
  return {
    name,
    version: '0.0.0',
    manifest: { apiVersion: '5', displayName: name } as PluginManifest,
    state: 'pending',
    disposables: [],
  }
}

describe('api.theme.accent', () => {
  const api = createPluginApi(makeRecord())

  it('resolve returns a hex string', () => {
    expect(api.theme.accent.resolve('#ff0000')).toBe('#ff0000')
  })

  it('resolve falls back for undefined input', () => {
    expect(api.theme.accent.resolve(undefined)).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('hexToRgba returns an rgba string', () => {
    expect(api.theme.accent.hexToRgba('#ff7700', 0.5)).toBe('rgba(255, 119, 0, 0.5)')
  })
})

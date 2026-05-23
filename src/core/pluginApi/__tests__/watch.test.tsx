// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { PluginRecord } from '../../pluginHost/registry'
import type { PluginManifest } from '@tinstar/plugin-api'
import { createPluginApi } from '../createApi'

// useFileWatch / useImageWatch call apiFetch. Stub it so the hook doesn't
// actually hit the network during the test.
vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ ok: true, data: { absolutePath: '/tmp/x' } }),
  })),
  apiUrl: (p: string) => p,
}))

function makeRecord(name = 'test-plugin'): PluginRecord {
  return {
    name,
    version: '0.0.0',
    manifest: { apiVersion: '5', displayName: name } as PluginManifest,
    state: 'pending',
    disposables: [],
  }
}

describe('api.watch', () => {
  it('file hook returns the expected shape', () => {
    const api = createPluginApi(makeRecord())
    const { result } = renderHook(() => api.watch.file('sess', '/foo'))
    expect(result.current).toHaveProperty('content')
    expect(result.current).toHaveProperty('connected')
    expect(result.current).toHaveProperty('lastUpdatedAt')
  })

  it('image hook returns the expected shape', () => {
    const api = createPluginApi(makeRecord())
    const { result } = renderHook(() => api.watch.image('sess', '/foo.png'))
    expect(result.current).toHaveProperty('connected')
    expect(result.current).toHaveProperty('lastUpdatedAt')
  })
})

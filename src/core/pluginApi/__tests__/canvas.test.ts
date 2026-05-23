import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PluginRecord } from '../../pluginHost/registry'
import type { PluginManifest } from '@tinstar/plugin-api'
import { createPluginApi } from '../createApi'
import { registerCanvasActions, _resetCanvasActionsRegistry } from '../../../hotkeys/canvasActionsRegistry'

function makeRecord(name = 'test-plugin'): PluginRecord {
  return {
    name,
    version: '0.0.0',
    manifest: { apiVersion: '5', displayName: name } as PluginManifest,
    state: 'pending',
    disposables: [],
  }
}

describe('api.canvas.fitWidget', () => {
  beforeEach(() => {
    _resetCanvasActionsRegistry()
  })

  it('routes through the canvas actions registry', () => {
    const fit = vi.fn()
    registerCanvasActions({ fit })
    const api = createPluginApi(makeRecord())
    api.canvas.fitWidget('w-1')
    expect(fit).toHaveBeenCalledWith('w-1')
  })

  it('is a no-op when no canvas is registered', () => {
    const api = createPluginApi(makeRecord())
    expect(() => api.canvas.fitWidget('w-1')).not.toThrow()
  })
})

import { describe, it, expect, vi, afterEach } from 'vitest'
import type { PluginRecord } from '../../pluginHost/registry'
import type { PluginManifest } from '@tinstar/plugin-api'
import { createPluginApi } from '../createApi'
import {
  deregisterActionHandler,
  dispatchAction,
} from '../../../hotkeys/actionHandlerRegistry'

function makeRecord(name = 'test-plugin'): PluginRecord {
  return {
    name,
    version: '0.0.0',
    manifest: { apiVersion: '5', displayName: name } as PluginManifest,
    state: 'pending',
    disposables: [],
  }
}

describe('api.hotkeys.onAction', () => {
  afterEach(() => {
    deregisterActionHandler('w-1')
  })

  it('registers the handler so dispatchAction reaches it', () => {
    const api = createPluginApi(makeRecord())
    const handler = vi.fn()
    api.hotkeys.onAction('w-1', handler)
    dispatchAction('w-1', 'fit-viewport')
    expect(handler).toHaveBeenCalledWith('fit-viewport')
  })

  it('returns a Disposable that deregisters the handler', () => {
    const api = createPluginApi(makeRecord())
    const handler = vi.fn()
    const d = api.hotkeys.onAction('w-1', handler)
    d.dispose()
    dispatchAction('w-1', 'fit-viewport')
    expect(handler).not.toHaveBeenCalled()
  })

  it('pushes the Disposable onto record.disposables for plugin teardown', () => {
    const record = makeRecord()
    const api = createPluginApi(record)
    api.hotkeys.onAction('w-1', () => {})
    expect(record.disposables).toHaveLength(1)
  })
})

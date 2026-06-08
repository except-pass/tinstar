import { describe, expect, it } from 'vitest'
import { resolveProxyTarget } from '../proxyResolve'

const browserWidgets = [{ id: 'browser-1', url: 'http://localhost:3000', headers: { 'X-A': '1' } }]
const pluginWidgets = [{ id: 'pw-9', data: { _browser: { url: 'http://localhost:8932/p/my-plan', headers: { 'X-B': '2' } } } }]

describe('resolveProxyTarget', () => {
  it('resolves a standalone browser-widget record', () => {
    expect(resolveProxyTarget('browser-1', browserWidgets as never, pluginWidgets as never))
      .toEqual({ url: 'http://localhost:3000', headers: { 'X-A': '1' } })
  })
  it('resolves an embedded browser from plugin widget data._browser', () => {
    expect(resolveProxyTarget('pw-9', browserWidgets as never, pluginWidgets as never))
      .toEqual({ url: 'http://localhost:8932/p/my-plan', headers: { 'X-B': '2' } })
  })
  it('returns null for an unknown node id', () => {
    expect(resolveProxyTarget('nope', browserWidgets as never, pluginWidgets as never)).toBeNull()
  })
  it('returns null for a plugin widget without _browser data', () => {
    expect(resolveProxyTarget('pw-x', browserWidgets as never, [{ id: 'pw-x', data: {} }] as never)).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { unproxyPath } from '../BrowserPrimitive'

// Mirror of proxyUrl() in BrowserPrimitive.tsx (kept local since that one is a
// closure inside makeBrowserPrimitive). unproxyPath must be its exact inverse so
// an iframe load doesn't churn the iframeSrc key and trigger a reload loop.
function proxyUrl(nodeId: string, targetUrl: string): string {
  try {
    const parsed = new URL(targetUrl)
    return `/api/proxy/${nodeId}${parsed.pathname}${parsed.search}`
  } catch {
    return `/api/proxy/${nodeId}/`
  }
}

const NODE = 'browser-abc'
const CURRENT = 'http://localhost:8932/p/oldslug'

describe('unproxyPath', () => {
  it('reconstructs the real URL from a proxied plan path', () => {
    expect(unproxyPath('/api/proxy/browser-abc/p/newslug', '', NODE, CURRENT))
      .toBe('http://localhost:8932/p/newslug')
  })

  it('preserves the query string', () => {
    expect(unproxyPath('/api/proxy/browser-abc/p/x', '?tab=2', NODE, CURRENT))
      .toBe('http://localhost:8932/p/x?tab=2')
  })

  it('maps the proxy root to the origin root', () => {
    expect(unproxyPath('/api/proxy/browser-abc/', '', NODE, CURRENT))
      .toBe('http://localhost:8932/')
    expect(unproxyPath('/api/proxy/browser-abc', '', NODE, CURRENT))
      .toBe('http://localhost:8932/')
  })

  it('returns null for a path outside this widget\'s proxy prefix', () => {
    expect(unproxyPath('/api/proxy/other-widget/p/x', '', NODE, CURRENT)).toBeNull()
    expect(unproxyPath('/somewhere/else', '', NODE, CURRENT)).toBeNull()
  })

  it('does not match a different node id that shares a prefix string', () => {
    // '/api/proxy/browser-ab' must not be treated as belonging to 'browser-abc'.
    expect(unproxyPath('/api/proxy/browser-abcd/p/x', '', NODE, CURRENT)).toBeNull()
  })

  it('returns null when the current URL has no parseable origin', () => {
    expect(unproxyPath('/api/proxy/browser-abc/p/x', '', NODE, 'not a url')).toBeNull()
  })

  it('round-trips with proxyUrl so a stable load is a no-op (no reload loop)', () => {
    const real = 'http://localhost:8932/p/keep?z=1'
    const proxied = proxyUrl(NODE, real)            // forward
    const parsed = new URL(proxied, 'http://x')     // split path/search the way the iframe location does
    const back = unproxyPath(parsed.pathname, parsed.search, NODE, real) // inverse
    expect(back).toBe(real)
  })
})

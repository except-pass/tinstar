import { describe, it, expect } from 'vitest'
import { decideStaticServe } from '../staticServe'

const CLIENT = '/client'

/** fileExists probe backed by a fixed set of existing absolute paths. */
const existing = (paths: string[]) => (p: string) => paths.includes(p)

describe('decideStaticServe', () => {
  it('serves an existing JS chunk with the JS mime type', () => {
    const d = decideStaticServe('/assets/app-abc123.js', CLIENT, existing(['/client/assets/app-abc123.js']))
    expect(d).toEqual({ kind: 'file', filePath: '/client/assets/app-abc123.js', mime: 'application/javascript' })
  })

  it('404s a MISSING JS chunk instead of SPA-falling-back to index.html', () => {
    // The bug: a stale/missing /assets/*.js must NOT be served as index.html (text/html),
    // or dynamic import() rejects with a MIME error and lazy widgets hang.
    const d = decideStaticServe('/assets/mermaid-STALEHASH.js', CLIENT, existing(['/client/index.html']))
    expect(d).toEqual({ kind: 'not-found' })
  })

  it('SPA-falls-back to index.html for an extension-less route', () => {
    const d = decideStaticServe('/some/client/route', CLIENT, existing(['/client/index.html']))
    expect(d).toEqual({ kind: 'spa', indexPath: '/client/index.html' })
  })

  it('404s an extension-less route when index.html is absent', () => {
    const d = decideStaticServe('/whatever', CLIENT, existing([]))
    expect(d).toEqual({ kind: 'not-found' })
  })

  it('serves index.html directly when requested with its extension', () => {
    const d = decideStaticServe('/index.html', CLIENT, existing(['/client/index.html']))
    expect(d).toEqual({ kind: 'file', filePath: '/client/index.html', mime: 'text/html' })
  })

  it('forbids path traversal outside clientDir', () => {
    const d = decideStaticServe('/../../etc/passwd', CLIENT, existing(['/etc/passwd']))
    expect(d).toEqual({ kind: 'forbidden' })
  })

  it('forbids a sibling-prefix escape that a bare startsWith check would allow', () => {
    // Resolves to /client-evil/secret.js — outside /client, but '/client-evil...'
    // string-starts-with '/client'. A path-boundary check must still reject it.
    const d = decideStaticServe('/../client-evil/secret.js', CLIENT, existing(['/client-evil/secret.js']))
    expect(d).toEqual({ kind: 'forbidden' })
  })

  it('falls back to octet-stream for an unknown extension that exists', () => {
    const d = decideStaticServe('/assets/data.bin', CLIENT, existing(['/client/assets/data.bin']))
    expect(d).toEqual({ kind: 'file', filePath: '/client/assets/data.bin', mime: 'application/octet-stream' })
  })
})

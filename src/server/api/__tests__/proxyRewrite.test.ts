import { describe, it, expect } from 'vitest'
import {
  rewriteQuotedPaths, rewriteCssUrls, rewriteProxyBody,
  rewriteUrlForProxy, proxyRuntimeShim,
} from '../proxyRewrite'

const BASE = '/api/proxy/w1'

describe('rewriteQuotedPaths (HTML/JSON/CSS — not JS)', () => {
  it('rewrites a double-quoted root-relative string literal', () => {
    expect(rewriteQuotedPaths('href="/page"', BASE)).toBe('href="/api/proxy/w1/page"')
  })

  it('rewrites a single-quoted root-relative string literal', () => {
    expect(rewriteQuotedPaths("href='/page'", BASE)).toBe("href='/api/proxy/w1/page'")
  })

  it('leaves protocol-relative //cdn URLs untouched', () => {
    expect(rewriteQuotedPaths('src="//cdn.example.com/x.js"', BASE)).toBe('src="//cdn.example.com/x.js"')
  })

  it('leaves non-root-relative paths untouched', () => {
    expect(rewriteQuotedPaths('href="./rel"', BASE)).toBe('href="./rel"')
    expect(rewriteQuotedPaths('href="https://x/y"', BASE)).toBe('href="https://x/y"')
  })
})

describe('rewriteCssUrls', () => {
  it('rewrites unquoted url(/foo)', () => {
    expect(rewriteCssUrls('background:url(/img/bg.png)', BASE)).toBe('background:url(/api/proxy/w1/img/bg.png)')
  })
  it('leaves protocol-relative url(//cdn) untouched', () => {
    expect(rewriteCssUrls('url(//cdn/x.png)', BASE)).toBe('url(//cdn/x.png)')
  })
})

describe('rewriteProxyBody', () => {
  it('leaves JavaScript byte-exact, including regex literals (regression: never corrupt /"/g)', () => {
    // The reviewer's case plus the harder regex-then-string case that defeats any
    // regex-based source rewrite. JS must be returned unchanged.
    const js = 'fetch("/api/data"); s.replace(/"/g, "&quot;"); import("/chunk.js")'
    expect(rewriteProxyBody(js, 'application/javascript', BASE)).toBe(js)
  })

  it('rewrites HTML attributes but leaves inline <script> bodies untouched', () => {
    const html = '<a href="/page"></a><script>var re=/"/g;fetch("/keep")</script>'
    const out = rewriteProxyBody(html, 'text/html', BASE)
    expect(out).toContain('href="/api/proxy/w1/page"')
    expect(out).toContain('<script>var re=/"/g;fetch("/keep")</script>')
  })

  it('rewrites JSON string values', () => {
    expect(rewriteProxyBody('{"next":"/page/2"}', 'application/json', BASE))
      .toBe('{"next":"/api/proxy/w1/page/2"}')
  })

  it('applies CSS url() rewriting on a CSS body', () => {
    expect(rewriteProxyBody('.a{background:url(/bg.png)}', 'text/css', BASE))
      .toBe('.a{background:url(/api/proxy/w1/bg.png)}')
  })

  it('does not apply CSS url() rewriting inside JS', () => {
    const js = 'const css = "url(/x.png)"'
    expect(rewriteProxyBody(js, 'application/javascript', BASE)).toBe(js)
  })
})

describe('rewriteUrlForProxy (runtime shim core)', () => {
  it('prefixes a root-relative URL — this is how fetch("/api") is handled at runtime', () => {
    expect(rewriteUrlForProxy('/api', BASE)).toBe('/api/proxy/w1/api')
    expect(rewriteUrlForProxy('/chunk.js', BASE)).toBe('/api/proxy/w1/chunk.js')
  })
  it('leaves protocol-relative, absolute, and relative URLs unchanged', () => {
    expect(rewriteUrlForProxy('//cdn/x', BASE)).toBe('//cdn/x')
    expect(rewriteUrlForProxy('https://x/y', BASE)).toBe('https://x/y')
    expect(rewriteUrlForProxy('./rel', BASE)).toBe('./rel')
    expect(rewriteUrlForProxy('rel', BASE)).toBe('rel')
    expect(rewriteUrlForProxy('', BASE)).toBe('')
  })
})

describe('proxyRuntimeShim', () => {
  it('embeds the proxy base and patches fetch / XHR / serviceWorker', () => {
    const shim = proxyRuntimeShim(BASE)
    expect(shim).toContain(JSON.stringify(BASE))
    expect(shim).toContain('window.fetch')
    expect(shim).toContain('XMLHttpRequest.prototype.open')
    expect(shim).toContain('serviceWorker.register')
  })

  it('is a self-contained IIFE (safe to drop inside <script>…</script>)', () => {
    const shim = proxyRuntimeShim(BASE)
    expect(shim.startsWith('(function(){')).toBe(true)
    expect(shim.trim().endsWith('()')).toBe(true)
    expect(shim).not.toContain('</script>') // can't prematurely close the tag
  })
})

import { describe, it, expect } from 'vitest'
import { resolveBinaryTarget, MANIFEST } from '../manifest'

describe('manifest.resolveBinaryTarget', () => {
  it('resolves prometheus target for darwin-arm64', () => {
    const t = resolveBinaryTarget('prometheus', 'darwin', 'arm64')
    expect(t.url).toContain('prometheus-2.54.1.darwin-arm64')
    expect(t.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(t.executableRelPath).toContain('prometheus')
  })

  it('resolves alloy target for linux-amd64', () => {
    const t = resolveBinaryTarget('alloy', 'linux', 'x64')
    expect(t.url).toContain('alloy-linux-amd64')
    expect(t.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('throws for unsupported platform (win32)', () => {
    expect(() => resolveBinaryTarget('prometheus', 'win32', 'x64')).toThrow(/not supported/i)
  })

  it('MANIFEST versions are pinned strings', () => {
    expect(typeof MANIFEST.prometheus.version).toBe('string')
    expect(typeof MANIFEST.alloy.version).toBe('string')
  })
})

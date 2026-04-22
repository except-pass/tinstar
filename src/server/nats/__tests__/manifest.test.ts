import { describe, it, expect } from 'vitest'
import { resolveNatsTarget } from '../manifest'

describe('resolveNatsTarget', () => {
  it('resolves linux-x64 to a tar.gz archive', () => {
    const t = resolveNatsTarget('linux', 'x64')
    expect(t.component).toBe('nats')
    expect(t.version).toBe('2.10.24')
    expect(t.archiveKind).toBe('tar.gz')
    expect(t.url).toContain('nats-server')
    expect(t.url).toContain('linux-amd64')
    expect(t.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(t.executableRelPath).toContain('nats-server')
  })

  it('resolves darwin-arm64 to a zip archive', () => {
    const t = resolveNatsTarget('darwin', 'arm64')
    expect(t.archiveKind).toBe('zip')
    expect(t.url).toContain('darwin-arm64')
  })

  it('throws for unsupported platform', () => {
    expect(() => resolveNatsTarget('win32', 'x64')).toThrow(/not supported/)
  })
})

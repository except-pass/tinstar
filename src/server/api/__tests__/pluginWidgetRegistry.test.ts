// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolvePluginIcon } from '../pluginWidgetRegistry'

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-icon-'))
  writeFileSync(join(dir, 'icon.svg'), '<svg/>')
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe('resolvePluginIcon', () => {
  it('returns undefined for no icon', () => {
    expect(resolvePluginIcon(dir, undefined)).toBeUndefined()
  })

  it('passes through URLs, data URIs, and web-root paths unchanged', () => {
    expect(resolvePluginIcon(dir, 'https://x/i.svg')).toBe('https://x/i.svg')
    expect(resolvePluginIcon(dir, 'http://x/i.png')).toBe('http://x/i.png')
    expect(resolvePluginIcon(dir, 'data:image/svg+xml,<svg/>')).toBe('data:image/svg+xml,<svg/>')
    expect(resolvePluginIcon(dir, '/agent-icons/foo.svg')).toBe('/agent-icons/foo.svg')
  })

  it('inlines a relative file as a base64 data URI', () => {
    const out = resolvePluginIcon(dir, 'icon.svg')
    expect(out).toBe(`data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`)
  })

  it('returns undefined for a missing relative file', () => {
    expect(resolvePluginIcon(dir, 'nope.svg')).toBeUndefined()
  })

  it('returns undefined for an unknown extension', () => {
    expect(resolvePluginIcon(dir, 'icon.bmp')).toBeUndefined()
  })
})

// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolvePluginIcon, resolveWidgetRegistry, invalidateWidgetRegistryCache } from '../pluginWidgetRegistry'

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

describe('resolveWidgetRegistry built-ins', () => {
  it('lists the palette-opt-in built-ins (Saloon, Browser) but not the context-only ones', () => {
    invalidateWidgetRegistryCache()
    // An empty configRoot (no plugins.json) → only the bundled built-ins surface.
    const reg = resolveWidgetRegistry(mkdtempSync(join(tmpdir(), 'no-plugins-')))
    const saloon = reg.find(w => w.widgetType === 'saloon')
    expect(saloon).toBeDefined()
    expect(saloon!.pluginId).toBe('nats-traffic')
    expect(saloon!.pluginDisplayName).toBe('Saloon')
    expect(saloon!.label).toBe('Saloon')
    expect(saloon!.spawn).toBe('palette')
    // Browser is now a standalone palette widget (decoupled from sessions) and declares
    // the 'spawnable' capability so it appears in the add-widget [+] picker.
    const browser = reg.find(w => w.widgetType === 'browser-widget')
    expect(browser).toBeDefined()
    expect(browser!.spawn).toBe('palette')
    expect(browser!.capabilities).toContain('spawnable')
    // file-editor / image-viewer omit `spawn` (context-only), so they stay out of the palette.
    expect(reg.find(w => w.widgetType === 'file-editor')).toBeUndefined()
    expect(reg.find(w => w.widgetType === 'image-viewer')).toBeUndefined()
  })

  it('omits the Saloon when its plugin is disabled', () => {
    invalidateWidgetRegistryCache()
    const d = mkdtempSync(join(tmpdir(), 'disabled-plugins-'))
    writeFileSync(join(d, 'plugins.json'), JSON.stringify({ disabled: ['nats-traffic'], external: [] }))
    const reg = resolveWidgetRegistry(d)
    expect(reg.find(w => w.widgetType === 'saloon')).toBeUndefined()
    invalidateWidgetRegistryCache()
  })
})

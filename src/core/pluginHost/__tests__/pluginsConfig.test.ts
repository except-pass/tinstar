import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readPluginsConfig } from '../pluginsConfig'

const TEST_ROOT = join(tmpdir(), 'tinstar-plugins-config-test-' + process.pid)

beforeEach(() => {
  if (existsSync(TEST_ROOT)) rmSync(TEST_ROOT, { recursive: true })
  mkdirSync(TEST_ROOT, { recursive: true })
})
afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true })
})

describe('readPluginsConfig', () => {
  it('returns empty config when plugins.json does not exist', () => {
    const cfg = readPluginsConfig(TEST_ROOT)
    expect(cfg).toEqual({ disabled: [], external: [] })
  })

  it('parses a valid plugins.json', () => {
    writeFileSync(join(TEST_ROOT, 'plugins.json'), JSON.stringify({
      disabled: ['nats-traffic'],
      external: [
        { name: 'papershore', path: '/abs/path' },
        { name: 'stretchplan', npm: '@tinstar/stretchplan' },
      ],
    }))
    const cfg = readPluginsConfig(TEST_ROOT)
    expect(cfg.disabled).toEqual(['nats-traffic'])
    expect(cfg.external.length).toBe(2)
    expect(cfg.external[0]).toEqual({ name: 'papershore', path: '/abs/path' })
  })

  it('returns empty config + warning on malformed JSON', () => {
    writeFileSync(join(TEST_ROOT, 'plugins.json'), '{ this is not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cfg = readPluginsConfig(TEST_ROOT)
    expect(cfg).toEqual({ disabled: [], external: [] })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('drops invalid entries from external array but keeps valid ones', () => {
    writeFileSync(join(TEST_ROOT, 'plugins.json'), JSON.stringify({
      disabled: [],
      external: [
        { name: 'good', path: '/x' },
        { name: 'bad' },
        { path: '/y' },
        { name: 'also-good', npm: '@scope/foo' },
      ],
    }))
    const cfg = readPluginsConfig(TEST_ROOT)
    expect(cfg.external.map(e => e.name)).toEqual(['good', 'also-good'])
  })

  it('coerces non-array disabled to empty array', () => {
    writeFileSync(join(TEST_ROOT, 'plugins.json'), JSON.stringify({
      disabled: 'oops-not-an-array',
      external: [],
    }))
    const cfg = readPluginsConfig(TEST_ROOT)
    expect(cfg.disabled).toEqual([])
  })
})

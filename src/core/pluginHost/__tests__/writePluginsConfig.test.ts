import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writePluginsConfig } from '../writePluginsConfig'
import { readPluginsConfig } from '../pluginsConfig'

const TEST_ROOT = join(tmpdir(), 'tinstar-write-cfg-' + process.pid)
beforeEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }); mkdirSync(TEST_ROOT, { recursive: true }) })
afterEach(() => { rmSync(TEST_ROOT, { recursive: true, force: true }) })

describe('writePluginsConfig', () => {
  it('round-trips with readPluginsConfig', () => {
    const cfg = { disabled: ['x'], external: [{ name: 'y', path: '/a' }] }
    writePluginsConfig(TEST_ROOT, cfg)
    expect(readPluginsConfig(TEST_ROOT)).toEqual(cfg)
  })
  it('creates configRoot if missing', () => {
    const sub = join(TEST_ROOT, 'nested', 'cfg')
    writePluginsConfig(sub, { disabled: [], external: [] })
    expect(existsSync(join(sub, 'plugins.json'))).toBe(true)
  })
  it('does not leave a stale .tmp file on success', () => {
    writePluginsConfig(TEST_ROOT, { disabled: [], external: [] })
    expect(existsSync(join(TEST_ROOT, 'plugins.json.tmp'))).toBe(false)
  })
})

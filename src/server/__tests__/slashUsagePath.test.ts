import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSlashUsagePath } from '../sessions/slashUsage-path'

let scratch: string
let prevOverride: string | undefined
let prevLegacy: string | undefined

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tinstar-slashusage-'))
  prevOverride = process.env.TINSTAR_CONFIG_HOME
  prevLegacy = process.env.TINSTAR_DATA_DIR
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
  if (prevOverride === undefined) delete process.env.TINSTAR_CONFIG_HOME
  else process.env.TINSTAR_CONFIG_HOME = prevOverride
  if (prevLegacy === undefined) delete process.env.TINSTAR_DATA_DIR
  else process.env.TINSTAR_DATA_DIR = prevLegacy
})

describe('resolveSlashUsagePath', () => {
  it('honors TINSTAR_CONFIG_HOME so a second backend does not stomp the primary', () => {
    process.env.TINSTAR_CONFIG_HOME = scratch
    expect(resolveSlashUsagePath()).toBe(join(scratch, 'slash-usage.json'))
  })

  it('falls back to ~/.config/tinstar/slash-usage.json when override is unset', () => {
    delete process.env.TINSTAR_CONFIG_HOME
    delete process.env.TINSTAR_DATA_DIR
    const p = resolveSlashUsagePath()
    expect(p.endsWith('/.config/tinstar/slash-usage.json')).toBe(true)
  })
})

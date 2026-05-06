import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getConfigRoot } from '../../src/server/configRoot'

describe('getConfigRoot', () => {
  let prevHome: string | undefined
  let prevData: string | undefined

  beforeEach(() => {
    prevHome = process.env.TINSTAR_CONFIG_HOME
    prevData = process.env.TINSTAR_DATA_DIR
    delete process.env.TINSTAR_CONFIG_HOME
    delete process.env.TINSTAR_DATA_DIR
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env.TINSTAR_CONFIG_HOME
    else process.env.TINSTAR_CONFIG_HOME = prevHome
    if (prevData === undefined) delete process.env.TINSTAR_DATA_DIR
    else process.env.TINSTAR_DATA_DIR = prevData
  })

  it('returns ~/.config/tinstar when no env vars set', () => {
    expect(getConfigRoot()).toBe(join(homedir(), '.config', 'tinstar'))
  })

  it('returns TINSTAR_CONFIG_HOME verbatim when set', () => {
    process.env.TINSTAR_CONFIG_HOME = '/tmp/rehearsal-config'
    expect(getConfigRoot()).toBe('/tmp/rehearsal-config')
  })

  it('falls back to default when TINSTAR_CONFIG_HOME is empty string', () => {
    process.env.TINSTAR_CONFIG_HOME = ''
    expect(getConfigRoot()).toBe(join(homedir(), '.config', 'tinstar'))
  })

  it('honors legacy TINSTAR_DATA_DIR when TINSTAR_CONFIG_HOME is unset', () => {
    process.env.TINSTAR_DATA_DIR = '/tmp/legacy-data'
    expect(getConfigRoot()).toBe('/tmp/legacy-data')
  })

  it('TINSTAR_CONFIG_HOME wins over legacy TINSTAR_DATA_DIR', () => {
    process.env.TINSTAR_CONFIG_HOME = '/tmp/new-home'
    process.env.TINSTAR_DATA_DIR = '/tmp/legacy-data'
    expect(getConfigRoot()).toBe('/tmp/new-home')
  })
})

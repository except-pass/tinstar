import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../sessions/config'

describe('config.firstmate', () => {
  function load(userConfig?: unknown) {
    const root = mkdtempSync(join(tmpdir(), 'fm-config-'))
    try {
      if (userConfig !== undefined) writeFileSync(join(root, 'config.json'), JSON.stringify(userConfig))
      return loadConfig({ _rootDir: root })
    } finally { rmSync(root, { recursive: true, force: true }) }
  }

  it('defaults to no homes, so the observer never starts', () => {
    expect(load().firstmate.homes).toEqual([])
  })

  it('keeps absolute string paths and drops everything else', () => {
    const cfg = load({ firstmate: { homes: ['/Users/me/firstmate', 'relative/path', 7, null] } })
    expect(cfg.firstmate.homes).toEqual(['/Users/me/firstmate'])
  })

  it('ignores a malformed block', () => {
    expect(load({ firstmate: { homes: '/x' } }).firstmate.homes).toEqual([])
    expect(load({ firstmate: 'nope' }).firstmate.homes).toEqual([])
  })
})

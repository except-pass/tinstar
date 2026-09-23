import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firstmatePortWindow, interactivePortWindow, loadConfig, portWindowsOverlap } from '../sessions/config'

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

  it('gives terminal views their own port window, disjoint from the interactive one', () => {
    const cfg = load()
    expect(cfg.firstmate.ports).toEqual({ start: 8781, count: 50 })
    const w = firstmatePortWindow(cfg)
    expect(w.label).toBe('firstmate-observer')
    expect(portWindowsOverlap(w, interactivePortWindow(cfg))).toBe(false)
  })

  it('accepts a sane user port window and ignores a malformed one', () => {
    expect(load({ firstmate: { ports: { start: 9100, count: 10 } } }).firstmate.ports).toEqual({ start: 9100, count: 10 })
    for (const bad of [{ start: 'x', count: 5 }, { start: 80, count: 5 }, { start: 8800, count: 0 }, { start: 65000, count: 900 }, 'nope']) {
      expect(load({ firstmate: { ports: bad } }).firstmate.ports).toEqual({ start: 8781, count: 50 })
    }
  })
})

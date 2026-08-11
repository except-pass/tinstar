import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearReachMapping,
  mappingIsOurs,
  reachInstanceId,
  readReachMapping,
  readReachPreference,
  writeReachMapping,
  writeReachPreference,
} from '../state'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tinstar-reach-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('reach state — preference and mapping are separate records', () => {
  it('reports nothing on a config root that has never opted in', () => {
    expect(readReachPreference(root)).toBeNull()
    expect(readReachMapping(root)).toBeNull()
  })

  it('survives a write-read cycle', () => {
    writeReachPreference(root, { enabled: true, provider: 'tailscale' })
    writeReachMapping(root, {
      provider: 'tailscale',
      instanceId: reachInstanceId(root),
      url: 'https://host.tailnet.ts.net',
      port: 5273,
      establishedAt: '2026-08-06T00:00:00.000Z',
    })

    expect(readReachPreference(root)?.enabled).toBe(true)
    expect(readReachMapping(root)?.url).toBe('https://host.tailnet.ts.net')
    expect(readReachMapping(root)?.port).toBe(5273)
  })

  it('clears the mapping without touching the preference', () => {
    // The whole reason these are two records. A clean shutdown revokes the
    // mapping; if that also erased the opt-in, reach would silently never come
    // back after a restart or reboot.
    writeReachPreference(root, { enabled: true, provider: 'tailscale' })
    writeReachMapping(root, {
      provider: 'tailscale',
      instanceId: reachInstanceId(root),
      url: 'https://host.tailnet.ts.net',
      port: 5273,
      establishedAt: '2026-08-06T00:00:00.000Z',
    })

    clearReachMapping(root)

    expect(readReachMapping(root)).toBeNull()
    expect(readReachPreference(root)?.enabled).toBe(true)
  })

  it('treats a malformed state file as no state rather than throwing', () => {
    mkdirSync(join(root, 'reach'), { recursive: true })
    writeFileSync(join(root, 'reach', 'mapping.json'), '{ not json')
    writeFileSync(join(root, 'reach', 'preference.json'), '[]')

    expect(() => readReachMapping(root)).not.toThrow()
    expect(readReachMapping(root)).toBeNull()
    expect(readReachPreference(root)).toBeNull()
  })

  it('treats a state file from a future version as no state', () => {
    mkdirSync(join(root, 'reach'), { recursive: true })
    writeFileSync(
      join(root, 'reach', 'mapping.json'),
      JSON.stringify({ version: 99, url: 'https://x', port: 1 }),
    )
    expect(readReachMapping(root)).toBeNull()
  })

  it('writes state only under the config root, never where callers read a base URL', () => {
    // R12: host-local callers resolve their base URL from server.host and
    // server.port. A reach URL reaching either would send `tinstar doctor` and
    // every hook out over the tailnet.
    writeReachPreference(root, { enabled: true, provider: 'tailscale' })
    writeReachMapping(root, {
      provider: 'tailscale',
      instanceId: reachInstanceId(root),
      url: 'https://host.tailnet.ts.net',
      port: 5273,
      establishedAt: '2026-08-06T00:00:00.000Z',
    })

    expect(() => readFileSync(join(root, 'server.host'), 'utf8')).toThrow()
    expect(() => readFileSync(join(root, 'server.port'), 'utf8')).toThrow()
  })
})

describe('reach instance identity — one instance never tears down another', () => {
  it('derives a stable discriminator from the config root', () => {
    expect(reachInstanceId(root)).toBe(reachInstanceId(root))
    expect(reachInstanceId(root)).not.toBe(reachInstanceId(`${root}-other`))
  })

  it('recognizes only its own mapping', () => {
    const mine = {
      version: 1,
      provider: 'tailscale',
      instanceId: reachInstanceId(root),
      url: 'https://host.tailnet.ts.net',
      port: 5273,
      establishedAt: '2026-08-06T00:00:00.000Z',
    }
    expect(mappingIsOurs(mine, reachInstanceId(root))).toBe(true)
    expect(mappingIsOurs(mine, reachInstanceId(`${root}-other`))).toBe(false)
  })
})

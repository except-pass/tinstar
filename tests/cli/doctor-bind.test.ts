import { describe, expect, it } from 'vitest'
import {
  TAILSCALE_FLOOR_VERIFIED_ON,
  TAILSCALE_MIN_VERSION,
  TERMINAL_AUTH_HEADER,
  TERMINAL_AUTH_VALUE,
  TTYD_MIN_VERSION,
  checkExternalVersion,
  checkReachState,
  classifyListenerBind,
  compareVersions,
  parseSsListeners,
} from '../../bin/tinstar/diagnostics.js'
import {
  TAILSCALE_FLOOR_VERIFIED_ON as TS_FLOOR_TS,
  TAILSCALE_MIN_VERSION as TS_MIN_TS,
  TTYD_MIN_VERSION as TTYD_MIN_TS,
} from '../../src/server/externalFloors'
import {
  TERMINAL_AUTH_HEADER as HEADER_TS,
  TERMINAL_AUTH_VALUE as HEADER_VALUE_TS,
} from '../../src/server/sessionProxy'

const SS_OUTPUT = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      511         127.0.0.1:5273       0.0.0.0:*     users:(("node",pid=101,fd=20))
LISTEN 0      511             [::1]:5273          [::]:*     users:(("node",pid=101,fd=21))
LISTEN 0      4096        127.0.0.1:8686       0.0.0.0:*     users:(("ttyd",pid=202,fd=8))
LISTEN 0      4096          0.0.0.0:8687       0.0.0.0:*     users:(("ttyd",pid=203,fd=8))
LISTEN 0      128           0.0.0.0:22         0.0.0.0:*     users:(("sshd",pid=1,fd=3))
`

describe('parseSsListeners', () => {
  it('reads address, port and owning process off ss -tlnp', () => {
    const listeners = parseSsListeners(SS_OUTPUT)
    expect(listeners).toContainEqual({ address: '127.0.0.1', port: 5273, process: 'node' })
    expect(listeners).toContainEqual({ address: '::1', port: 5273, process: 'node' })
    expect(listeners).toContainEqual({ address: '0.0.0.0', port: 8687, process: 'ttyd' })
  })

  it('unbrackets IPv6 addresses so they compare against the loopback literal', () => {
    expect(parseSsListeners(SS_OUTPUT).find(l => l.address === '[::1]')).toBeUndefined()
  })

  it('returns nothing rather than throwing on unusable output', () => {
    expect(parseSsListeners('')).toEqual([])
    expect(parseSsListeners('ss: command not found')).toEqual([])
  })
})

describe('classifyListenerBind — a non-loopback listener is a failure, named', () => {
  it('passes an all-loopback listener set', () => {
    const check = classifyListenerBind('Tinstar server', [
      { address: '127.0.0.1', port: 5273, process: 'node' },
      { address: '::1', port: 5273, process: 'node' },
    ])
    expect(check.status).toBe('pass')
  })

  it('fails a wildcard bind and names the address', () => {
    const check = classifyListenerBind('terminal :8687', [
      { address: '0.0.0.0', port: 8687, process: 'ttyd' },
    ])
    expect(check.status).toBe('fail')
    expect(`${check.label} ${check.detail ?? ''}`).toContain('0.0.0.0')
  })

  it('fails a LAN bind and names the address', () => {
    const check = classifyListenerBind('terminal :8688', [
      { address: '192.168.1.51', port: 8688, process: 'ttyd' },
    ])
    expect(check.status).toBe('fail')
    expect(`${check.label} ${check.detail ?? ''}`).toContain('192.168.1.51')
  })

  it('fails when a loopback listener sits alongside a wide one', () => {
    // The dangerous shape: localhost works, so nothing looks wrong locally.
    const check = classifyListenerBind('Tinstar server', [
      { address: '127.0.0.1', port: 5273, process: 'node' },
      { address: '192.168.1.51', port: 5273, process: 'node' },
    ])
    expect(check.status).toBe('fail')
    expect(`${check.label} ${check.detail ?? ''}`).toContain('192.168.1.51')
  })

  it('accepts every address in the loopback range', () => {
    expect(classifyListenerBind('x', [
      { address: '127.0.0.53', port: 1, process: 'node' },
    ]).status).toBe('pass')
  })

  it('reports nothing found as a skip, not a pass', () => {
    // A listener that is not there cannot be proven loopback-only.
    expect(classifyListenerBind('Tinstar server', []).status).toBe('skip')
  })
})

describe('checkExternalVersion — both floors, named on both sides', () => {
  it('passes at or above the floor', () => {
    expect(checkExternalVersion('ttyd', '1.7.4', TTYD_MIN_VERSION).status).toBe('pass')
    expect(checkExternalVersion('ttyd', '1.8.0', TTYD_MIN_VERSION).status).toBe('pass')
  })

  it('fails below the floor, naming installed and required', () => {
    const check = checkExternalVersion('tailscale', '1.98.4', TAILSCALE_MIN_VERSION)
    expect(check.status).toBe('fail')
    const text = `${check.label} ${check.detail ?? ''}`
    expect(text).toContain('1.98.4')
    expect(text).toContain(TAILSCALE_MIN_VERSION)
  })

  it('compares numerically, so 1.98.10 is above 1.98.9', () => {
    expect(compareVersions('1.98.10', '1.98.9')).toBeGreaterThan(0)
    expect(checkExternalVersion('tailscale', '1.98.10', '1.98.9').status).toBe('pass')
  })

  it('reports an absent binary as a PATH problem with the fix', () => {
    const check = checkExternalVersion('tailscale', null, TAILSCALE_MIN_VERSION)
    expect(check.status).toBe('fail')
    expect(`${check.label} ${check.detail ?? ''}`).toMatch(/PATH|install/i)
  })
})

describe('checkReachState', () => {
  it('reports inactive — not failed — when the provider is absent', () => {
    // Reach is opt-in. A host that never wanted it is not broken.
    const check = checkReachState({ providerPresent: false, mapping: null })
    expect(check.status).toBe('skip')
    expect(check.label).toMatch(/inactive|not (installed|configured)/i)
  })

  it('reports inactive when the provider is present but nothing is mapped', () => {
    expect(checkReachState({ providerPresent: true, mapping: null }).status).toBe('skip')
  })

  it('reports the URL when a mapping is active', () => {
    const check = checkReachState({
      providerPresent: true,
      mapping: { url: 'https://host.tailnet.ts.net', port: 5273 },
    })
    expect(check.status).toBe('pass')
    expect(`${check.label} ${check.detail ?? ''}`).toContain('https://host.tailnet.ts.net')
  })

  it('fails when the mapping fronts a port nothing is listening on', () => {
    const check = checkReachState({
      providerPresent: true,
      mapping: { url: 'https://host.tailnet.ts.net', port: 5273 },
      serverPort: 5281,
    })
    expect(check.status).toBe('fail')
    expect(`${check.label} ${check.detail ?? ''}`).toContain('5273')
  })
})

describe('the provider floor carries its verification date', () => {
  it('publishes when it was last checked against advisories', () => {
    // A floor that has gone stale after a later bulletin is invisible
    // otherwise — nothing else in the system would ever mention it.
    expect(TAILSCALE_FLOOR_VERIFIED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('agrees with the server-side adapter, so the two cannot drift', () => {
    // doctor is plain JS and cannot import TypeScript, so these constants exist
    // in two places. This test is the only thing keeping them honest.
    expect(TAILSCALE_MIN_VERSION).toBe(TS_MIN_TS)
    expect(TAILSCALE_FLOOR_VERIFIED_ON).toBe(TS_FLOOR_TS)
  })

  it('agrees with the server on the ttyd floor the spawner enforces', () => {
    // doctor REPORTS this floor; src/server/sessions/backends/tmux.ts REFUSES
    // below it. Two different numbers would mean doctor says clean while the
    // spawner refuses, or worse the reverse.
    expect(TTYD_MIN_VERSION).toBe(TTYD_MIN_TS)
  })

  it('agrees with the server on the terminal auth header', () => {
    // doctor's own terminal probes present this. A drift here makes doctor
    // report every healthy terminal as broken.
    expect(TERMINAL_AUTH_HEADER).toBe(HEADER_TS)
    expect(TERMINAL_AUTH_VALUE).toBe(HEADER_VALUE_TS)
  })
})

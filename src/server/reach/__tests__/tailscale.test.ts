import { describe, expect, it, vi } from 'vitest'
import {
  TAILSCALE_BIN,
  TAILSCALE_FLOOR_VERIFIED_ON,
  TAILSCALE_MIN_VERSION,
  TailscaleReachProvider,
  compareVersions,
  parseServeMappings,
  parseTailscaleVersion,
  serveEstablishArgv,
  serveRevokeArgv,
} from '../tailscale'

/** The ServeConfig shape `tailscale serve status --json` prints. */
const SERVE_CONFIG = {
  TCP: { 443: { HTTPS: true } },
  Web: {
    'host.tailnet.ts.net:443': {
      Handlers: { '/': { Proxy: 'http://127.0.0.1:5273' } },
    },
  },
}

function fakeExec(handlers: Record<string, { stdout?: string; fail?: Error }>) {
  const calls: string[][] = []
  const run = vi.fn(async (argv: readonly string[]) => {
    calls.push([...argv])
    for (const [key, result] of Object.entries(handlers)) {
      if (argv.join(' ').includes(key)) {
        if (result.fail) throw result.fail
        return { stdout: result.stdout ?? '', stderr: '' }
      }
    }
    return { stdout: '', stderr: '' }
  })
  return { run, calls }
}

function provider(handlers: Record<string, { stdout?: string; fail?: Error }>) {
  const exec = fakeExec(handlers)
  return {
    exec,
    provider: new TailscaleReachProvider({ exec: exec.run }),
  }
}

const AT_FLOOR = { stdout: `${TAILSCALE_MIN_VERSION}\n  tailscale commit: abc\n` }
const BELOW_FLOOR = { stdout: '1.98.4\n  tailscale commit: abc\n' }
const HEALTHY_STATUS = {
  stdout: JSON.stringify({
    BackendState: 'Running',
    Self: { DNSName: 'host.tailnet.ts.net.' },
    CertDomains: ['host.tailnet.ts.net'],
  }),
}

describe('tailscale version floor', () => {
  it('reads the version off the first line', () => {
    expect(parseTailscaleVersion('1.98.9\n  tailscale commit: abc\n')).toBe('1.98.9')
    expect(parseTailscaleVersion('1.98.4-t9e69045b2-ged3a62f14\n')).toBe('1.98.4')
  })

  it('returns null rather than guessing at unrecognized output', () => {
    expect(parseTailscaleVersion('')).toBeNull()
    expect(parseTailscaleVersion('command not found')).toBeNull()
  })

  it('orders versions numerically, not lexically', () => {
    // '1.98.10' < '1.98.9' as strings. That comparison would silently admit a
    // vulnerable build, which is the one thing this gate exists to stop.
    expect(compareVersions('1.98.10', '1.98.9')).toBeGreaterThan(0)
    expect(compareVersions('1.98.4', '1.98.9')).toBeLessThan(0)
    expect(compareVersions('1.98.9', '1.98.9')).toBe(0)
    expect(compareVersions('2.0.0', '1.98.9')).toBeGreaterThan(0)
  })

  it('publishes the date the floor was last checked against advisories', () => {
    // A floor that has gone stale after a later bulletin is otherwise invisible.
    expect(TAILSCALE_FLOOR_VERIFIED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('serve command surface', () => {
  it('establishes in the background without an interactive prompt', () => {
    // Revoke runs at shutdown and repair runs at boot, both unattended. A
    // command that can prompt is itself the failure mode.
    const argv = serveEstablishArgv(5273)
    expect(argv).toContain('--bg')
    expect(argv).toContain('--yes')
    expect(argv.at(-1)).toBe('http://127.0.0.1:5273')
  })

  it('revokes only its own mapping and never the reset form', () => {
    // KTD5: `tailscale serve reset` wipes the node's whole serving config,
    // including mappings the operator created by hand.
    const argv = serveRevokeArgv({ port: 5273, url: 'https://host.tailnet.ts.net' })
    expect(argv).not.toContain('reset')
    expect(argv.at(-1)).toBe('off')
  })
})

describe('serve status parsing', () => {
  it('reads the mapping set the node currently serves', () => {
    expect(parseServeMappings(JSON.stringify(SERVE_CONFIG))).toEqual([
      { port: 5273, url: 'https://host.tailnet.ts.net' },
    ])
  })

  it('reports no mappings for an unconfigured node', () => {
    expect(parseServeMappings('{}')).toEqual([])
    expect(parseServeMappings('')).toEqual([])
    expect(parseServeMappings('not json')).toEqual([])
  })

  it('ignores a handler that does not proxy a loopback port', () => {
    expect(parseServeMappings(JSON.stringify({
      Web: { 'host.tailnet.ts.net:443': { Handlers: { '/': { Text: 'hello' } } } },
    }))).toEqual([])
  })
})

describe('TailscaleReachProvider — every refusal names its unmet precondition', () => {
  it('refuses when the binary is absent, naming the prerequisite', async () => {
    const { provider: p } = provider({
      version: { fail: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) },
    })
    await expect(p.establish({ port: 5273 })).rejects.toThrow(/tailscale.*not (installed|on PATH)/i)
  })

  it('refuses below the floor, naming installed and required versions', async () => {
    const { provider: p } = provider({ version: BELOW_FLOOR })
    await expect(p.establish({ port: 5273 }))
      .rejects.toThrow(new RegExp(`1\\.98\\.4.*${TAILSCALE_MIN_VERSION.replace(/\./g, '\\.')}`))
  })

  it('refuses when the daemon is not running, naming that', async () => {
    const { provider: p } = provider({
      version: AT_FLOOR,
      'status --json': { stdout: JSON.stringify({ BackendState: 'NeedsLogin' }) },
    })
    await expect(p.establish({ port: 5273 })).rejects.toThrow(/NeedsLogin|not (logged in|running)/i)
  })

  it('refuses when HTTPS certificates are off, naming the tailnet-wide setting', async () => {
    // MagicDNS and HTTPS are admin-console settings, not device settings. A node
    // with them off fails to serve with no local cause to find.
    const { provider: p } = provider({
      version: AT_FLOOR,
      'status --json': {
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: { DNSName: 'host.tailnet.ts.net.' },
          CertDomains: [],
        }),
      },
    })
    await expect(p.establish({ port: 5273 })).rejects.toThrow(/HTTPS/i)
  })

  it('refuses when MagicDNS gives the node no name', async () => {
    const { provider: p } = provider({
      version: AT_FLOOR,
      'status --json': {
        stdout: JSON.stringify({ BackendState: 'Running', Self: {}, CertDomains: ['x'] }),
      },
    })
    await expect(p.establish({ port: 5273 })).rejects.toThrow(/MagicDNS/i)
  })

  it('refuses when privilege is unavailable, naming the scoped grant', async () => {
    // Not the provider's daemon-wide operator grant: that confers control of
    // the whole daemon and is the pivot in one of the advisories this gates on.
    const { provider: p } = provider({
      version: AT_FLOOR,
      'status --json': HEALTHY_STATUS,
      'serve --bg': { fail: new Error('access denied: serve access denied') },
    })
    await expect(p.establish({ port: 5273 })).rejects.toThrow(/sudoers|privilege|permission/i)
    await expect(p.establish({ port: 5273 })).rejects.not.toThrow(/--operator/)
  })

  it('establishes and reports the node URL', async () => {
    const { provider: p, exec } = provider({
      version: AT_FLOOR,
      'status --json': HEALTHY_STATUS,
      'serve status --json': { stdout: JSON.stringify(SERVE_CONFIG) },
    })

    await expect(p.establish({ port: 5273 }))
      .resolves.toEqual({ port: 5273, url: 'https://host.tailnet.ts.net' })
    expect(exec.calls.some(c => c.includes('--bg'))).toBe(true)
  })

  it('reads the current mapping set without needing privilege', async () => {
    const { provider: p, exec } = provider({
      'serve status --json': { stdout: JSON.stringify(SERVE_CONFIG) },
    })

    await expect(p.currentMappings())
      .resolves.toEqual([{ port: 5273, url: 'https://host.tailnet.ts.net' }])
    // Reads stay unprivileged so doctor and boot reconcile never need sudo.
    expect(exec.calls.every(c => !c.includes('sudo'))).toBe(true)
  })

  it('escalates privilege for establish, because reads cannot mutate serve', async () => {
    const { provider: p, exec } = provider({
      version: AT_FLOOR,
      'status --json': HEALTHY_STATUS,
      'serve status --json': { stdout: JSON.stringify(SERVE_CONFIG) },
    })

    await p.establish({ port: 5273 })

    const mutate = exec.calls.find(c => c.includes('--bg'))!
    expect(mutate[0]).toBe('sudo')
    expect(mutate[1]).toBe('-n')
    expect(mutate[2]).toBe(TAILSCALE_BIN)
  })

  it('escalates privilege for revoke too', async () => {
    const { provider: p, exec } = provider({})
    await p.revoke({ port: 5273, url: 'https://host.tailnet.ts.net' })

    const mutate = exec.calls.find(c => c.includes('off'))!
    expect(mutate.slice(0, 3)).toEqual(['sudo', '-n', TAILSCALE_BIN])
  })

  it('still reports the mapping when the status read-back fails after serve succeeded', async () => {
    // serve already mutated the daemon. Throwing here would leave a live
    // tailnet mapping with no record, and reconcile would then treat it as a
    // foreign holder and refuse forever.
    const { provider: p } = provider({
      version: AT_FLOOR,
      'status --json': HEALTHY_STATUS,
      'serve status --json': { fail: new Error('local API unavailable') },
    })

    await expect(p.establish({ port: 5273 })).resolves.toEqual({
      port: 5273,
      url: 'https://host.tailnet.ts.net',
    })
  })

  it('reports no mappings rather than throwing when the binary is absent', async () => {
    // currentMappings runs at boot on every host, including ones that have
    // never heard of Tailscale. It must be inert there.
    const { provider: p } = provider({
      'serve status': { fail: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) },
    })
    await expect(p.currentMappings()).resolves.toEqual([])
  })

  it('revokes with the scoped removal', async () => {
    const { provider: p, exec } = provider({})
    await p.revoke({ port: 5273, url: 'https://host.tailnet.ts.net' })
    expect(exec.calls.some(c => c.includes('reset'))).toBe(false)
    expect(exec.calls.some(c => c.includes('off'))).toBe(true)
  })
})


import { describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import {
  LOOPBACK_BIND_ADDRESS,
  LOOPBACK_BIND_ADDRESS_V6,
  openListeners,
  resolveBindTargets,
} from '../../src/server/bind'

function bindError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

/** Servers whose listen() fails with the named code for the named hosts. */
function fakeServers(failures: Record<string, string>): {
  make: () => Server
  listened: string[]
  closed: string[]
} {
  const listened: string[] = []
  const closed: string[] = []
  return {
    listened,
    closed,
    make: () => {
      const emitter = createServer(() => {})
      let asked = ''
      const s = {
        listen: (_port: number, host: string) => {
          asked = host
          const code = failures[host]
          if (code) {
            queueMicrotask(() => emitter.emit('error', bindError(code)))
          } else {
            listened.push(host)
            queueMicrotask(() => emitter.emit('listening'))
          }
        },
        close: () => { closed.push(asked) },
        once: emitter.once.bind(emitter),
        on: emitter.on.bind(emitter),
        removeListener: emitter.removeListener.bind(emitter),
      }
      return s as unknown as Server
    },
  }
}

function connectResult(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect({ host, port, timeout: 1_500 })
    sock.on('connect', () => { sock.destroy(); resolve('connected') })
    sock.on('timeout', () => { sock.destroy(); resolve('timeout') })
    sock.on('error', (err: NodeJS.ErrnoException) => {
      sock.destroy()
      resolve(err.code ?? 'error')
    })
  })
}

function hasSecondLoopbackAddress(): boolean {
  return Object.values(networkInterfaces()).flat().some(
    entry => entry?.family === 'IPv4'
      && entry.address.startsWith('127.')
      && entry.address !== '127.0.0.1',
  )
}

function firstNonLoopbackIPv4(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address
    }
  }
  return null
}

describe('resolveBindTargets — what the server listens on', () => {
  it('defaults to the loopback pair and nothing else', () => {
    const bind = resolveBindTargets(undefined)
    expect(bind.targets.map(t => t.host)).toEqual(['127.0.0.1', '::1'])
    expect(bind.targets.map(t => t.host)).not.toContain('0.0.0.0')
    expect(bind.targets.map(t => t.host)).not.toContain('::')
  })

  it('treats an empty host list the same as no host at all', () => {
    expect(resolveBindTargets([]).targets.map(t => t.host))
      .toEqual(['127.0.0.1', '::1'])
    expect(resolveBindTargets('').targets.map(t => t.host))
      .toEqual(['127.0.0.1', '::1'])
  })

  it('makes only the IPv6 loopback best-effort', () => {
    const bind = resolveBindTargets(undefined)
    expect(bind.targets.find(t => t.host === '127.0.0.1')?.required).toBe(true)
    expect(bind.targets.find(t => t.host === '::1')?.required).toBe(false)
  })

  it('keeps the URL and host file on names host-local callers can build', () => {
    const bind = resolveBindTargets(undefined)
    expect(bind.preferredHost).toBe('localhost')
    expect(bind.hostFileValue).toBe('127.0.0.1')
  })

  it('adds the IPv4 loopback to an explicit external host', () => {
    const bind = resolveBindTargets('192.168.1.5')
    expect(bind.targets.map(t => t.host)).toEqual(['192.168.1.5', '127.0.0.1'])
    expect(bind.targets.every(t => t.required)).toBe(true)
    expect(bind.preferredHost).toBe('192.168.1.5')
    expect(bind.hostFileValue).toBe('192.168.1.5')
  })

  it('adds the IPv4 loopback to an explicit IPv6 loopback host', () => {
    // bin/apiBase.js builds `http://${host}:${port}` with no bracketing, so an
    // IPv6 literal in the host file breaks every tinstar subcommand.
    const bind = resolveBindTargets('::1')
    expect(bind.targets.map(t => t.host)).toEqual(['::1', '127.0.0.1'])
    expect(bind.hostFileValue).toBe('127.0.0.1')
    expect(bind.preferredHost).not.toContain(':')
  })

  it('leaves a wildcard host untouched', () => {
    expect(resolveBindTargets('0.0.0.0').targets.map(t => t.host))
      .toEqual(['0.0.0.0'])
    expect(resolveBindTargets('::').targets.map(t => t.host))
      .toEqual(['::'])
    expect(resolveBindTargets('localhost').targets.map(t => t.host))
      .toEqual(['localhost'])
  })

  it('accepts repeated and comma-collected hosts in order', () => {
    const bind = resolveBindTargets(['100.64.0.1', '127.0.0.1'])
    expect(bind.targets.map(t => t.host)).toEqual(['100.64.0.1', '127.0.0.1'])
    expect(bind.preferredHost).toBe('100.64.0.1')
  })
})

describe('openListeners — best-effort IPv6, fatal address-in-use', () => {
  it('leaves the IPv4 listener serving when the IPv6 address is unsupported', async () => {
    const fake = fakeServers({ '::1': 'EAFNOSUPPORT' })
    const opened = await openListeners(
      resolveBindTargets(undefined).targets,
      5273,
      fake.make,
    )
    expect(fake.listened).toEqual(['127.0.0.1'])
    expect(opened).toHaveLength(1)
    // The IPv4 listener stays up; only the socket that never bound is released.
    expect(fake.closed).toEqual(['::1'])
  })

  it('tolerates an unavailable IPv6 loopback address', async () => {
    const fake = fakeServers({ '::1': 'EADDRNOTAVAIL' })
    await expect(openListeners(
      resolveBindTargets(undefined).targets, 5273, fake.make,
    )).resolves.toHaveLength(1)
    expect(fake.listened).toEqual(['127.0.0.1'])
  })

  it('rolls back and rethrows address-in-use so port fallback still runs', async () => {
    const fake = fakeServers({ '::1': 'EADDRINUSE' })
    await expect(openListeners(
      resolveBindTargets(undefined).targets, 5273, fake.make,
    )).rejects.toMatchObject({ code: 'EADDRINUSE' })
    // The IPv4 listener that already bound this port must be released, or the
    // retry on port+1 leaves a stray listener on the original.
    expect(fake.closed).toEqual(['127.0.0.1'])
  })

  it('never tolerates a failure on a required address', async () => {
    const fake = fakeServers({ '127.0.0.1': 'EADDRNOTAVAIL' })
    await expect(openListeners(
      resolveBindTargets(undefined).targets, 5273, fake.make,
    )).rejects.toMatchObject({ code: 'EADDRNOTAVAIL' })
  })

  it('binds exactly the loopback pair and refuses everything else', async () => {
    const opened = await openListeners(
      resolveBindTargets(undefined).targets,
      0,
      () => createServer((_req, res) => { res.end('ok') }),
    )
    try {
      const bound = opened.map(s => {
        const addr = s.address()
        return typeof addr === 'object' && addr ? addr.address : String(addr)
      })
      // Node reports the IPv6 loopback as '::1'; skip the assertion entirely on
      // a host that could not bind it, which is the whole point of best-effort.
      expect(bound).toContain('127.0.0.1')
      expect(bound.every(a => a === '127.0.0.1' || a === '::1')).toBe(true)

      const first = opened[0]!.address()
      const port = typeof first === 'object' && first ? first.port : 0
      expect(await connectResult('127.0.0.1', port)).toBe('connected')

      const lan = firstNonLoopbackIPv4()
      if (lan) expect(await connectResult(lan, port)).not.toBe('connected')

      if (hasSecondLoopbackAddress()) {
        expect(await connectResult('127.0.0.2', port)).not.toBe('connected')
      }
    } finally {
      for (const s of opened) s.close()
    }
  }, 15_000)
})

describe('the loopback literal has one source', () => {
  it('is the same constant the terminal spawner binds', async () => {
    // R3: one setting governs the dashboard listener and every ttyd. Two
    // independent literals is how they drift.
    const { terminalBindAddress } = await import('../../src/server/sessions/backends/tmux')
    expect(terminalBindAddress()).toBe(LOOPBACK_BIND_ADDRESS)
    expect(resolveBindTargets(undefined).targets[0]!.host)
      .toBe(LOOPBACK_BIND_ADDRESS)
    expect(resolveBindTargets(undefined).targets[1]!.host)
      .toBe(LOOPBACK_BIND_ADDRESS_V6)
  })
})

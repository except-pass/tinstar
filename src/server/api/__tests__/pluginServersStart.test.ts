import { describe, it, expect, vi, beforeEach } from 'vitest'

const onMock = vi.fn()
const spawnMock = vi.fn(() => ({ unref: vi.fn(), on: onMock }))
const openSyncMock = vi.fn(() => 7)
const mkdirSyncMock = vi.fn()
const closeSyncMock = vi.fn()
const appendFileSyncMock = vi.fn()

vi.mock('node:child_process', () => ({ exec: vi.fn(), spawn: (...a: unknown[]) => (spawnMock as (...x: unknown[]) => unknown)(...a) }))
// pluginServers imports the logger to report what the guest-env boundary
// withheld; logger.ts mkdirSync's its log dir at MODULE LOAD, which this suite's
// node:fs mock doesn't serve. Stub it — this suite is about spawn options.
vi.mock('../../logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../../../core/pluginHost/pluginsConfig', () => ({
  readPluginsConfig: () => ({ disabled: [], external: [
    { name: 'who', path: '/p/who' },
    { name: 'nostart', path: '/p/nostart' },
  ] }),
}))
vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  mkdirSync: (...a: unknown[]) => (mkdirSyncMock as (...x: unknown[]) => unknown)(...a),
  openSync: (...a: unknown[]) => (openSyncMock as (...x: unknown[]) => unknown)(...a),
  closeSync: (...a: unknown[]) => (closeSyncMock as (...x: unknown[]) => unknown)(...a),
  appendFileSync: (...a: unknown[]) => (appendFileSyncMock as (...x: unknown[]) => unknown)(...a),
  readFileSync: (p: string) => {
    if (String(p).includes('/p/who/')) return JSON.stringify({ name: 'who', version: '0.1.0', tinstar: { apiVersion: '5', displayName: 'Who', server: { health: 'h', start: 'bun run start', cwd: '..' } } })
    if (String(p).includes('/p/nostart/')) return JSON.stringify({ name: 'nostart', version: '0.1.0', tinstar: { apiVersion: '5', displayName: 'No', server: { health: 'h' } } })
    throw new Error('unexpected ' + p)
  },
}))

import { startServer, NoStartError } from '../pluginServers'

beforeEach(() => { spawnMock.mockClear(); openSyncMock.mockClear(); mkdirSyncMock.mockClear(); closeSyncMock.mockClear(); onMock.mockClear(); appendFileSyncMock.mockClear() })

describe('startServer', () => {
  it('spawns the start command with shell+detached, in cwd, logging to a file fd', () => {
    const r = startServer('/cfg', 'who')
    expect(r).toEqual({ started: true })
    expect(mkdirSyncMock).toHaveBeenCalledWith('/cfg/plugin-servers', { recursive: true })
    expect(openSyncMock).toHaveBeenCalledWith('/cfg/plugin-servers/who.log', 'w')
    const [cmd, opts] = (spawnMock.mock.calls[0]! as unknown) as [string, Record<string, unknown>]
    expect(cmd).toBe('bun run start')
    expect(opts.shell).toBe(true)
    expect(opts.detached).toBe(true)
    expect(opts.cwd).toBe('/p') // join('/p/who','..')
    expect(opts.stdio).toEqual(['ignore', 7, 7])
    // GUEST BOUNDARY (see sessions/guestEnv.ts). Without this assertion, deleting
    // `env:` from startServer silently restores the inherited environment — and
    // a plugin whose start script runs `npm install` loses its devDependencies
    // with no error. The env must be an explicit scoped object, never undefined.
    const env = opts.env as Record<string, string> | undefined
    expect(env).toBeDefined()
    expect(env).not.toHaveProperty('NODE_ENV')
    expect(closeSyncMock).toHaveBeenCalledWith(7)
  })

  it('attaches an error handler so an async spawn failure cannot crash the host', () => {
    startServer('/cfg', 'who')
    const [event, handler] = (onMock.mock.calls[0]! as unknown) as [string, (e: Error) => void]
    expect(event).toBe('error')
    // handler logs the failure instead of throwing
    handler(new Error('ENOENT: bad cwd'))
    expect(appendFileSyncMock).toHaveBeenCalledWith('/cfg/plugin-servers/who.log', expect.stringContaining('failed to start'))
  })

  it('throws NoStartError when the plugin declares no start command', () => {
    expect(() => startServer('/cfg', 'nostart')).toThrow(NoStartError)
  })

  it('throws NoStartError for an unknown plugin', () => {
    expect(() => startServer('/cfg', 'ghost')).toThrow(NoStartError)
  })
})

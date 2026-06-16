import { describe, it, expect, vi, beforeEach } from 'vitest'

const spawnMock = vi.fn(() => ({ unref: vi.fn() }))
const openSyncMock = vi.fn(() => 7)
const mkdirSyncMock = vi.fn()
const closeSyncMock = vi.fn()

vi.mock('node:child_process', () => ({ exec: vi.fn(), spawn: (...a: unknown[]) => (spawnMock as (...x: unknown[]) => unknown)(...a) }))
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
  readFileSync: (p: string) => {
    if (String(p).includes('/p/who/')) return JSON.stringify({ name: 'who', version: '0.1.0', tinstar: { apiVersion: '5', displayName: 'Who', server: { health: 'h', start: 'bun run start', cwd: '..' } } })
    if (String(p).includes('/p/nostart/')) return JSON.stringify({ name: 'nostart', version: '0.1.0', tinstar: { apiVersion: '5', displayName: 'No', server: { health: 'h' } } })
    throw new Error('unexpected ' + p)
  },
}))

import { startServer, NoStartError } from '../pluginServers'

beforeEach(() => { spawnMock.mockClear(); openSyncMock.mockClear(); mkdirSyncMock.mockClear(); closeSyncMock.mockClear() })

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
    expect(closeSyncMock).toHaveBeenCalledWith(7)
  })

  it('throws NoStartError when the plugin declares no start command', () => {
    expect(() => startServer('/cfg', 'nostart')).toThrow(NoStartError)
  })

  it('throws NoStartError for an unknown plugin', () => {
    expect(() => startServer('/cfg', 'ghost')).toThrow(NoStartError)
  })
})

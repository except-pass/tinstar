import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock child_process.exec: the 3rd arg is the callback (err) => void.
const execMock = vi.fn()
vi.mock('node:child_process', () => ({
  exec: (cmd: string, opts: unknown, cb: (err: Error | null) => void) => execMock(cmd, opts, cb),
  spawn: vi.fn(),
}))
// Mock the config reader so getStatuses resolves a known entry set.
vi.mock('../../../core/pluginHost/pluginsConfig', () => ({
  readPluginsConfig: () => ({ disabled: [], external: [{ name: 'who', path: '/p/who' }] }),
}))
vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  readFileSync: () => JSON.stringify({
    name: 'who', version: '0.1.0',
    tinstar: { apiVersion: '5', displayName: 'Who', server: { health: 'probe', start: 'go', healthTimeoutMs: 1000 } },
  }),
}))

import { getStatuses, __resetStatusCacheForTests } from '../pluginServers'

beforeEach(() => { execMock.mockReset(); __resetStatusCacheForTests() })

describe('getStatuses', () => {
  it('reports up when the health command exits 0', async () => {
    execMock.mockImplementation((_c, _o, cb) => cb(null))
    const s = await getStatuses('/cfg', 1000)
    expect(s['who']!).toEqual({ status: 'up', startable: true, checkedAt: 1000 })
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it('reports down when the health command errors (non-zero or timeout)', async () => {
    execMock.mockImplementation((_c, _o, cb) => cb(new Error('exit 1')))
    const s = await getStatuses('/cfg', 1000)
    expect(s['who']!.status).toBe('down')
  })

  it('serves cached status within the TTL without re-running the command', async () => {
    execMock.mockImplementation((_c, _o, cb) => cb(null))
    await getStatuses('/cfg', 1000)
    await getStatuses('/cfg', 1500) // 500ms later, < 4000ms TTL
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it('re-checks after the TTL expires', async () => {
    execMock.mockImplementation((_c, _o, cb) => cb(null))
    await getStatuses('/cfg', 1000)
    await getStatuses('/cfg', 6000) // > TTL
    expect(execMock).toHaveBeenCalledTimes(2)
  })
})

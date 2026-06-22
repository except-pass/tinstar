import { describe, it, expect, vi } from 'vitest'

// 'who' is a resolved server plugin; its log lives at <cfg>/plugin-servers/who.log.
vi.mock('../../../core/pluginHost/pluginsConfig', () => ({
  readPluginsConfig: () => ({ disabled: [], external: [{ name: 'who', path: '/p/who' }] }),
}))
vi.mock('node:fs', async (orig) => ({
  ...(await orig<typeof import('node:fs')>()),
  readFileSync: (p: string) => {
    const path = String(p)
    if (path.includes('/p/who/')) {
      return JSON.stringify({ name: 'who', version: '0.1.0', tinstar: { apiVersion: '5', displayName: 'Who', server: { health: 'h', start: 'go' } } })
    }
    if (path.endsWith('/plugin-servers/who.log')) return Buffer.from('boot output')
    throw new Error('ENOENT ' + path)
  },
}))

import { readServerLog } from '../pluginServers'

describe('readServerLog', () => {
  it('returns the log for a resolved plugin', () => {
    expect(readServerLog('/cfg', 'who')).toBe('boot output')
  })

  it('returns "" for an unknown plugin id (no log leak)', () => {
    expect(readServerLog('/cfg', 'ghost')).toBe('')
  })

  it('blocks path traversal — a crafted id matches no resolved plugin', () => {
    // Would otherwise read <cfg>/plugin-servers/../../../etc/passwd.log
    expect(readServerLog('/cfg', '../../../etc/passwd')).toBe('')
  })
})

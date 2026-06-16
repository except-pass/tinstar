import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { buildServerEntries } from '../pluginServers'

const pkg = (name: string, server: unknown) => ({
  name, version: '0.1.0',
  tinstar: { apiVersion: '5', displayName: name[0]!.toUpperCase() + name.slice(1), server },
})

describe('buildServerEntries', () => {
  const config = {
    disabled: ['off'],
    external: [
      { name: 'whoachart', path: '/repo/whoachart/tinstar-plugin' },
      { name: 'noserver', path: '/repo/noserver' },
      { name: 'off', path: '/repo/off' },
      { name: 'npmonly' }, // no path → skipped
    ],
  }
  const readPkg = (dir: string) => {
    if (dir === '/repo/whoachart/tinstar-plugin') return pkg('whoachart', { health: 'curl -sf x', start: 'bun run start', cwd: '..' })
    if (dir === '/repo/noserver') return pkg('noserver', undefined)
    if (dir === '/repo/off') return pkg('off', { health: 'h' })
    throw new Error('unexpected dir ' + dir)
  }

  it('returns one entry per external plugin that declares a server, with cwd resolved', () => {
    const entries = buildServerEntries(config, readPkg)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.pluginId).toBe('whoachart')
    expect(entries[0]!.displayName).toBe('Whoachart')
    expect(entries[0]!.spec.start).toBe('bun run start')
    expect(entries[0]!.cwd).toBe(join('/repo/whoachart/tinstar-plugin', '..'))
  })

  it('defaults cwd to the plugin dir when spec.cwd is omitted', () => {
    const entries = buildServerEntries(
      { disabled: [], external: [{ name: 'a', path: '/p/a' }] },
      () => pkg('a', { health: 'h' }),
    )
    expect(entries[0]!.cwd).toBe('/p/a')
  })

  it('skips plugins whose package.json fails to read or parse', () => {
    const entries = buildServerEntries(
      { disabled: [], external: [{ name: 'bad', path: '/p/bad' }] },
      () => { throw new Error('ENOENT') },
    )
    expect(entries).toEqual([])
  })
})

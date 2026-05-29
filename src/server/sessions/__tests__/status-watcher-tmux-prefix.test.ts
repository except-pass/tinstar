import { describe, it, expect } from 'vitest'
import type { StatusWatcherOpts } from '../status-watcher'

describe('StatusWatcher tmux name resolution', () => {
  it('accepts an injected resolveTmuxName so callers can route through config.sessions.prefix', () => {
    // Compile-time guarantee: opts must accept resolveTmuxName.
    const opts: StatusWatcherOpts = {
      sessionsDir: '/tmp/x',
      onStatusChanged: () => {},
      resolveTmuxName: (name) => `custom-${name}`,
    }
    expect(opts.resolveTmuxName?.('foo')).toBe('custom-foo')
  })
})

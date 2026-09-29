import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import {
  FirstmateViews, orphanViewTtydPids, parsePs, parseWindowRef, resolveViewScript, staleViewSessions,
  viewTtydArgv, type ViewsDeps,
} from './views'

const SCRIPT = '/opt/tinstar/bin/tinstar-fm-view'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: string | null = null
  killed: string[] = []
  kill(sig: string) { this.killed.push(sig); this.signalCode = sig; this.emit('exit', null, sig); return true }
}

function harness(over: Partial<ViewsDeps> = {}, windows = '@0 zsh\n@4 fm-fix-login\n') {
  const tmuxCalls: string[][] = []
  const spawned: { argv: string[]; child: FakeChild }[] = []
  const released: number[] = []
  let nextPort = 8781
  const deps: Partial<ViewsDeps> = {
    tmux: async args => {
      tmuxCalls.push(args)
      if (args[0] === 'list-windows') return windows
      return ''
    },
    ps: async () => '',
    findPort: async () => nextPort++,
    releasePort: p => { released.push(p) },
    healthCheck: async () => true,
    bindAddress: () => '127.0.0.1',
    authHeader: 'X-Tinstar-Proxy',
    ttydRefusal: () => null,
    spawnTtyd: argv => { const child = new FakeChild(); spawned.push({ argv, child }); return child as unknown as ChildProcess },
    killPid: vi.fn(),
    now: () => 1_000_000,
    ...over,
  }
  const exits: string[] = []
  const views = new FirstmateViews({
    window: { label: 'firstmate-observer', start: 8781, count: 50 },
    deps, script: SCRIPT, onExit: id => exits.push(id),
  })
  return { views, tmuxCalls, spawned, released, exits, deps }
}

describe('parseWindowRef', () => {
  it('accepts a plain session:window target', () => {
    expect(parseWindowRef('firstmate:fm-fix-login')).toEqual({ session: 'firstmate', windowName: 'fm-fix-login' })
  })
  it('rejects anything else, including view sessions', () => {
    for (const t of [null, '', 'firstmate', 'a:b:c', 'x:$(id)', 'tsview-a:fm-x', 't:fm-x', 'tsview:fm-x', ' a:b', 'a:b;c']) expect(parseWindowRef(t)).toBeNull()
  })
})

describe('viewTtydArgv', () => {
  it('binds the configured address, requires the proxy header, and runs the view script with argv (no shell)', () => {
    const argv = viewTtydArgv({ port: 8790, bind: '127.0.0.1', authHeader: 'X-Tinstar-Proxy', task: 'fix-login', script: SCRIPT, session: 'firstmate', windowId: '@4', windowName: 'fm-fix-login' })
    expect(argv).toEqual(expect.arrayContaining(['-W', '-i', '127.0.0.1', '-H', 'X-Tinstar-Proxy', '-p', '8790']))
    expect(argv.slice(-4)).toEqual([SCRIPT, 'firstmate', '@4', 'fm-fix-login'])
    expect(argv).toContain('fontSize=14')
    expect(argv).toContain('macOptionClickForcesSelection=true')
    expect(argv).not.toContain('bash')
    expect(argv).not.toContain('--once')
  })
})

describe('FirstmateViews.ensure', () => {
  it('resolves the window id, starts one ttyd, and is idempotent', async () => {
    const h = harness()
    const r = await h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login')
    expect(r).toEqual({ state: 'live', port: 8781 })
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]!.argv.slice(-3)).toEqual(['firstmate', '@4', 'fm-fix-login'])
    expect(await h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login')).toEqual({ state: 'live', port: 8781 })
    expect(h.spawned).toHaveLength(1)
  })

  it('shares one attempt between concurrent calls', async () => {
    const h = harness()
    const [a, b] = await Promise.all([
      h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login'),
      h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login'),
    ])
    expect(a).toEqual(b)
    expect(h.spawned).toHaveLength(1)
  })

  it('is unavailable — and starts nothing — without a usable window', async () => {
    const h = harness()
    for (const t of [null, 'firstmate:fm-other', 'garbage']) {
      const r = await h.views.ensure('fm--fix-login', 'fix-login', t)
      expect(r.state).toBe('unavailable')
    }
    expect(h.spawned).toHaveLength(0)
  })

  it('treats a missing tmux session as "no such window", but an unreadable tmux as an error', async () => {
    const gone = harness({ tmux: async () => { throw Object.assign(new Error('x'), { stderr: "can't find session: firstmate" }) } })
    expect(await gone.views.ensure('fm--a', 'a', 'firstmate:fm-a')).toEqual({ state: 'unavailable', reason: 'worker window not found' })
    const broken = harness({ tmux: async () => { throw Object.assign(new Error('boom'), { stderr: 'weird' }) } })
    expect((await broken.views.ensure('fm--a', 'a', 'firstmate:fm-a')).state).toBe('unavailable')
    expect(broken.spawned).toHaveLength(0)
  })

  it('keeps a healthy ttyd when a later tmux read fails transiently', async () => {
    let broken = false
    const h = harness({ tmux: async () => { if (broken) throw Object.assign(new Error('timeout'), { stderr: 'timed out' }); return '@4 fm-fix-login\n' } })
    expect(await h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login')).toEqual({ state: 'live', port: 8781 })
    broken = true
    expect(await h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login')).toEqual({ state: 'live', port: 8781 })
    expect(h.spawned).toHaveLength(1)
    expect(h.spawned[0]!.child.killed).toEqual([])
    expect(h.views.portOf('fm--fix-login')).toBe(8781)
  })

  it('restarts when the worker window id changes (relaunch), releasing the old port', async () => {
    let windows = '@4 fm-fix-login\n'
    const h = harness({ tmux: async () => windows })
    await h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login')
    windows = '@9 fm-fix-login\n'
    const r = await h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login')
    expect(r).toEqual({ state: 'live', port: 8782 })
    expect(h.spawned[0]!.child.killed).toEqual(['SIGTERM'])
    expect(h.released).toContain(8781)
  })

  it('reports unavailable when ttyd is refused, and when the port window is exhausted', async () => {
    const refused = harness({ ttydRefusal: () => 'ttyd not found' })
    expect(await refused.views.ensure('fm--a', 'fix-login', 'firstmate:fm-fix-login')).toEqual({ state: 'unavailable', reason: 'ttyd not found' })
    const full = harness({ findPort: async () => { throw new Error('No available port') } })
    expect((await full.views.ensure('fm--a', 'fix-login', 'firstmate:fm-fix-login')).state).toBe('unavailable')
  })

  it('kills a ttyd that never becomes healthy and frees its port', async () => {
    const h = harness({ healthCheck: async () => false })
    const r = await h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login')
    expect(r.state).toBe('unavailable')
    expect(h.spawned[0]!.child.killed).toEqual(['SIGTERM'])
    expect(h.released).toEqual([8781])
    expect(h.views.portOf('fm--fix-login')).toBeNull()
  })

  it('a ttyd that exits on its own frees its port and notifies the observer', async () => {
    const h = harness()
    await h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login')
    h.spawned[0]!.child.exitCode = 1
    h.spawned[0]!.child.emit('exit', 1, null)
    expect(h.released).toEqual([8781])
    expect(h.exits).toEqual(['fm--fix-login'])
    expect(h.views.portOf('fm--fix-login')).toBeNull()
  })

  it('release stops the ttyd without notifying, and stop() ends every view', async () => {
    const h = harness()
    await h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login')
    h.views.release('fm--fix-login')
    expect(h.spawned[0]!.child.killed).toEqual(['SIGTERM'])
    expect(h.exits).toEqual([])
    await h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login')
    h.views.stop()
    expect(h.spawned[1]!.child.killed).toEqual(['SIGTERM'])
    expect(h.exits).toEqual([])
  })

  it('only ever runs read-only tmux verbs against workers; kill-session and send-keys only name tsview- sessions', async () => {
    const h = harness({ tmux: async args => {
      h.tmuxCalls.push(args)
      if (args[0] === 'list-sessions') return `firstmate\t1\t900000\ntsview-a-1\t0\t100\ntsview-b-2\t1\t100\ntsview-c-3\t0\t999990\n`
      if (args[0] === 'list-panes') return 'firstmate\t@4\t1\ntsview-fix-login-9\t@4\t1\n'
      if (args[0] === 'list-clients') return '/dev/ttys009\n'
      return '@4 fm-fix-login\n'
    } })
    await h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login')
    await h.views.start()
    await h.views.leave('fm--fix-login')
    h.views.release('fm--fix-login')
    const verbs = new Set(h.tmuxCalls.map(c => c[0]))
    expect([...verbs].sort()).toEqual(['kill-session', 'list-clients', 'list-panes', 'list-sessions', 'list-windows', 'send-keys', 'switch-client'])
    const kills = h.tmuxCalls.filter(c => c[0] === 'kill-session')
    expect(kills).toEqual([['kill-session', '-t', '=tsview-a-1']])   // unattached + old; not b (attached), not c (fresh)
    expect(h.tmuxCalls.filter(c => c[0] === 'send-keys')).toEqual([['send-keys', '-X', '-t', '=tsview-fix-login-9:', 'cancel']])
    expect(h.tmuxCalls.filter(c => c[0] === 'list-clients')).toEqual([['list-clients', '-t', '=tsview-fix-login-9', '-F', '#{client_tty}']])
    expect(h.tmuxCalls.filter(c => c[0] === 'switch-client')).toEqual([['switch-client', '-c', '/dev/ttys009', '-T', 'tsview-passthrough']])
    for (const c of h.tmuxCalls) expect(c.join(' ')).not.toMatch(/kill-window|kill-pane|respawn|kill-server| -g\b/)
  })
})

describe('FirstmateViews.leave', () => {
  it('cancels the mode through a view of the left worker only when its pane is in one, and returns its clients to passthrough', async () => {
    const passthrough = (tty: string) => ['switch-client', '-c', tty, '-T', 'tsview-passthrough']
    for (const [rows, expected] of [
      ['tsview-other-1\t@5\t1\ntsview-fix-login-2\t@4\t1\n', [['send-keys', '-X', '-t', '=tsview-fix-login-2:', 'cancel'], passthrough('/dev/tty-tsview-fix-login-2')]],
      ['tsview-fix-login-2\t@4\t0\nfirstmate\t@4\t0\n', [passthrough('/dev/tty-tsview-fix-login-2')]],
      ['firstmate\t@4\t1\n', []],
    ] as [string, string[][]][]) {
      const sent: string[][] = []
      const h = harness({ tmux: async args => {
        if (args[0] === 'send-keys' || args[0] === 'switch-client') sent.push(args)
        if (args[0] === 'list-panes') return rows
        if (args[0] === 'list-clients') return `/dev/tty-${args[2]!.slice(1)}\n`
        return args[0] === 'list-windows' ? '@4 fm-fix-login\n@5 fm-other\n' : ''
      } })
      await h.views.ensure('fm--fix-login', 'fix-login', 'firstmate:fm-fix-login')
      await h.views.leave('fm--fix-login')
      expect(sent).toEqual(expected)
    }
  })

  it('does nothing for a worker without a live view', async () => {
    const h = harness()
    await h.views.leave('fm--fix-login')
    expect(h.tmuxCalls).toEqual([])
  })
})

describe('orphan sweep helpers', () => {
  const ps = [
    `  100     1 ttyd -W -i 127.0.0.1 -H X-Tinstar-Proxy -p 8781 -t titleFixed=a ${SCRIPT} firstmate @4 fm-a`,
    `  101   555 ttyd -W -i 127.0.0.1 -H X-Tinstar-Proxy -p 8782 -t titleFixed=b ${SCRIPT} firstmate @5 fm-b`,
    `  102     1 ttyd -W -p 7681 bash -c tmux attach -t =tinstar-x`,
    `  103     1 vim ${SCRIPT} notes`,
    `  104     1 /usr/local/bin/ttyd -W -p 8783 ${SCRIPT} firstmate @6 fm-c`,
  ].join('\n')
  it('lists only orphaned (ppid 1) ttyds running the view script', () => {
    expect(orphanViewTtydPids(parsePs(ps), SCRIPT)).toEqual([100, 104])
  })
  it('sweepOrphanTtyds kills exactly those pids', async () => {
    const killPid = vi.fn()
    const h = harness({ ps: async () => ps, killPid })
    expect(await h.views.sweepOrphanTtyds()).toBe(2)
    expect(killPid.mock.calls.map(c => c[0])).toEqual([100, 104])
  })
  it('staleViewSessions ignores attached, fresh, and non-tsview sessions', () => {
    const rows = [
      { name: 'firstmate', attached: 0, createdSec: 1 },
      { name: 'tinstar-x', attached: 0, createdSec: 1 },
      { name: 'tsview-a', attached: 0, createdSec: 1 },
      { name: 'tsview-b', attached: 1, createdSec: 1 },
      { name: 'tsview-c', attached: 0, createdSec: 990 },
    ]
    expect(staleViewSessions(rows, 1000)).toEqual(['tsview-a'])
  })
})

describe('resolveViewScript', () => {
  it('finds the shipped bin/tinstar-fm-view from this directory', () => {
    expect(resolveViewScript(__dirname)).toMatch(/bin\/tinstar-fm-view$/)
  })
})

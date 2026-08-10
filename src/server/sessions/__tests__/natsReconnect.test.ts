// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  filterChannelServerPids,
  reapSessionNatsChannelServer,
  reconnectSessionNats,
} from '../natsReconnect'

describe('reconnectSessionNats', () => {
  it('SIGTERMs every process matching the control-socket path', async () => {
    const signalled: Array<[number, string]> = []
    const res = await reconnectSessionNats('sess-a', {
      socketPath: '/tmp/tinstar-nats-sess-a.sock',
      findPids: async () => [101, 102],
      kill: (pid, sig) => { signalled.push([pid, sig]) },
    })
    expect(res.killed).toEqual([101, 102])
    expect(signalled).toEqual([[101, 'SIGTERM'], [102, 'SIGTERM']])
  })

  it('is a no-op when no channel-server process is found', async () => {
    let killCalls = 0
    const res = await reconnectSessionNats('sess-b', {
      socketPath: '/tmp/tinstar-nats-sess-b.sock',
      findPids: async () => [],
      kill: () => { killCalls++ },
    })
    expect(res.killed).toEqual([])
    expect(killCalls).toBe(0)
  })

  it('never signals the tinstar host process itself', async () => {
    const signalled: number[] = []
    const res = await reconnectSessionNats('sess-c', {
      socketPath: '/tmp/tinstar-nats-sess-c.sock',
      findPids: async () => [process.pid, 999],
      kill: (pid) => { signalled.push(pid) },
    })
    expect(res.killed).toEqual([999])
    expect(signalled).toEqual([999])
  })

  it('swallows kill failures (process already exited) and keeps going', async () => {
    const signalled: number[] = []
    const res = await reconnectSessionNats('sess-d', {
      socketPath: '/tmp/tinstar-nats-sess-d.sock',
      findPids: async () => [201, 202],
      kill: (pid) => {
        if (pid === 201) throw new Error('ESRCH')
        signalled.push(pid)
      },
    })
    // Both are reported as targeted; the failure on 201 doesn't stop 202.
    expect(res.killed).toEqual([201, 202])
    expect(signalled).toEqual([202])
  })
})

describe('reapSessionNatsChannelServer', () => {
  it('targets the stable per-session control-socket path', async () => {
    const needles: string[] = []
    const res = await reapSessionNatsChannelServer('standup', {
      findPids: async (needle) => {
        needles.push(needle)
        return [4242]
      },
      kill: () => {},
    })
    expect(needles).toEqual(['/tmp/tinstar-nats-standup.sock'])
    expect(res).toEqual({ sessionName: 'standup', killed: [4242] })
  })
})

describe('filterChannelServerPids', () => {
  it('keeps nats-channel-mcp and drops the Codex parent that embeds the socket path', () => {
    const cmdlines: Record<number, string> = {
      10: 'codex\0resume\0--last\0--control-socket\0/tmp/tinstar-nats-standup.sock',
      11: 'bun\0x\0nats-channel-mcp\0--control-socket\0/tmp/tinstar-nats-standup.sock',
      12: 'bun\0/tmp/bunx-…/nats-channel-mcp\0--control-socket\0/tmp/tinstar-nats-standup.sock',
    }
    expect(filterChannelServerPids([10, 11, 12], (pid) => cmdlines[pid]!)).toEqual([11, 12])
  })

  it('skips PIDs whose cmdline disappears mid-scan', () => {
    expect(filterChannelServerPids([99], () => { throw new Error('ENOENT') })).toEqual([])
  })
})

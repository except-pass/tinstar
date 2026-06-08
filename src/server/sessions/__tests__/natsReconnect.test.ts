// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { reconnectSessionNats } from '../natsReconnect'

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

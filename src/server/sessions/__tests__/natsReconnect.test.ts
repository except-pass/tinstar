// @vitest-environment node
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  filterChannelServerPids,
  reapSessionNatsChannelServer,
  reconnectSessionNats,
} from '../natsReconnect'

function liveProcessIdentity(pid: number): string | undefined {
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
    const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    return `linux:${bootId}:${startTicks}`
  }
  if (process.platform === 'darwin') {
    const started = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim()
    return started ? `darwin:${started}` : undefined
  }
  return undefined
}

describe('reconnectSessionNats', () => {
  it('SIGTERMs every process matching the control-socket path', async () => {
    const signalled: Array<[number, string]> = []
    const res = await reconnectSessionNats('sess-a', {
      socketPath: '/tmp/tinstar-nats-sess-a.sock',
      findPids: async () => [101, 102],
      kill: (pid, sig) => { signalled.push([pid, sig]) },
      isAlive: () => false,
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
      isAlive: () => false,
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
      isAlive: () => false,
    })
    // Both are reported as targeted; the failure on 201 doesn't stop 202.
    expect(res.killed).toEqual([201, 202])
    expect(signalled).toEqual([202])
  })

  it('signals discovered and recorded owner processes before removing their generation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-nats-owner-wait-'))
    const ownerLockPath = join(root, 'owner')
    mkdirSync(ownerLockPath)
    writeFileSync(join(ownerLockPath, 'owner.json'), JSON.stringify({
      version: 1,
      markerId: 'owner-wait',
      incarnation: 'owner-wait-v1',
      launcher: { version: 1, pid: 301, processIdentity: 'test' },
    }))
    const signalled: number[] = []
    let ownerReads = 0
    try {
      const res = await reconnectSessionNats('sess-owner', {
        socketPath: '/tmp/tinstar-nats-sess-owner.sock',
        ownerLockPath,
        resetOwnerState: true,
        findPids: async () => [302],
        readOwnerTargets: () => ownerReads++ === 0 ? [301] : [],
        kill: (pid) => { signalled.push(pid) },
        isAlive: () => false,
        wait: async () => {},
      })
      expect(res.killed).toEqual([302, 301])
      expect(signalled).toEqual([302, 301])
      expect(ownerReads).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a live managed-owner reset before signalling any process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-nats-owner-live-'))
    const ownerLockPath = join(root, 'owner')
    mkdirSync(ownerLockPath)
    writeFileSync(join(ownerLockPath, 'owner.json'), JSON.stringify({
      version: 1,
      markerId: 'owner-live',
      incarnation: 'owner-live-v1',
      launcher: { version: 1, pid: 301, processIdentity: 'test' },
    }))
    const signalled: number[] = []
    try {
      await expect(reconnectSessionNats('sess-owner-live', {
        socketPath: '/tmp/tinstar-nats-sess-owner-live.sock',
        ownerLockPath,
        findPids: async () => [301],
        kill: pid => { signalled.push(pid) },
      })).rejects.toThrow('restart the session instead')
      expect(signalled).toEqual([])
      expect(existsSync(join(ownerLockPath, 'owner.json'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reads the owner marker and rejects a reused PID identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-nats-owner-marker-'))
    const socketPath = join(root, 'control.sock')
    const ownerDir = join(root, 'private-owner')
    mkdirSync(ownerDir)
    const helper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    try {
      expect(helper.pid).toBeTypeOf('number')
      const identity = liveProcessIdentity(helper.pid!)
      if (!identity) return

      const ownerFile = join(ownerDir, 'owner.json')
      writeFileSync(ownerFile, JSON.stringify({
        version: 1,
        markerId: 'matching',
        incarnation: 'matching-v1',
        launcher: { version: 1, pid: helper.pid, processIdentity: identity },
      }))
      writeFileSync(join(ownerDir, '.child-matching.json'), JSON.stringify({
        version: 1,
        markerId: 'matching',
        pid: helper.pid,
        processIdentity: identity,
        state: 'starting',
      }))
      const signalled: number[] = []
      await expect(reconnectSessionNats('sess-marker', {
        socketPath,
        ownerLockPath: ownerDir,
        resetOwnerState: true,
        findPids: async () => [],
        kill: pid => { signalled.push(pid) },
        timeoutMs: 0,
      })).rejects.toThrow(`NATS channel-server processes did not exit: ${helper.pid}`)
      expect(signalled).toEqual([helper.pid])

      writeFileSync(ownerFile, JSON.stringify({
        version: 1,
        markerId: 'stale',
        incarnation: 'matching-v1',
        launcher: { version: 1, pid: helper.pid, processIdentity: `${identity}-reused` },
      }))
      signalled.length = 0
      const stale = await reconnectSessionNats('sess-marker', {
        socketPath,
        ownerLockPath: ownerDir,
        resetOwnerState: true,
        findPids: async () => [],
        kill: pid => { signalled.push(pid) },
      })
      expect(stale.killed).toEqual([])
      expect(signalled).toEqual([])
    } finally {
      helper.kill('SIGTERM')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('retires a started generation when its channel exits before discovery', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-nats-started-owner-'))
    const ownerLockPath = join(root, 'owner')
    mkdirSync(ownerLockPath)
    const identity = liveProcessIdentity(process.pid)
    writeFileSync(join(ownerLockPath, 'owner.json'), JSON.stringify({
      version: 1,
      markerId: 'started-owner',
      incarnation: 'started-owner-v1',
      launcher: { version: 1, pid: process.pid, processIdentity: identity },
    }))
    writeFileSync(join(ownerLockPath, '.child-started-owner.json'), JSON.stringify({
      version: 1,
      markerId: 'started-owner',
      pid: process.pid,
      processIdentity: identity,
      state: 'started',
      channelGroup: { version: 1, pgid: 2_147_483_647, leaderProcessIdentity: 'gone' },
    }))
    try {
      const result = await reconnectSessionNats('sess-started', {
        socketPath: join(root, 'missing-control.sock'),
        ownerLockPath,
        resetOwnerState: true,
        findPids: async () => [],
      })
      expect(result.killed).toEqual([])
      expect(() => readFileSync(join(ownerLockPath, 'owner.json'))).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('targets the recorded channel after startup instead of its supervisor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-nats-channel-owner-'))
    const ownerLockPath = join(root, 'owner')
    mkdirSync(ownerLockPath)
    const channel = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    try {
      const identity = liveProcessIdentity(channel.pid!)
      const supervisorIdentity = liveProcessIdentity(process.pid)
      if (!identity || !supervisorIdentity) return
      writeFileSync(join(ownerLockPath, 'owner.json'), JSON.stringify({
        version: 1,
        markerId: 'channel-owner',
        incarnation: 'channel-owner-v1',
        launcher: { version: 1, pid: process.pid, processIdentity: supervisorIdentity },
      }))
      writeFileSync(join(ownerLockPath, '.child-channel-owner.json'), JSON.stringify({
        version: 1,
        markerId: 'channel-owner',
        pid: process.pid,
        processIdentity: supervisorIdentity,
        state: 'started',
        channelGroup: { version: 1, pgid: channel.pid, leaderProcessIdentity: identity },
      }))
      const signalled: number[] = []
      const result = await reconnectSessionNats('sess-channel-owner', {
        socketPath: join(root, 'missing-control.sock'),
        ownerLockPath,
        resetOwnerState: true,
        findPids: async () => [],
        kill: pid => { signalled.push(pid) },
        isAlive: () => false,
      })
      expect(result.killed).toEqual([channel.pid])
      expect(signalled).toEqual([-channel.pid!])
    } finally {
      channel.kill('SIGTERM')
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('waits for the retiring owner generation to exit before returning', async () => {
    let probes = 0
    let waits = 0
    await reconnectSessionNats('sess-slow', {
      socketPath: '/tmp/tinstar-nats-sess-slow.sock',
      findPids: async () => [401],
      readOwnerTargets: () => [],
      kill: () => {},
      isAlive: () => ++probes < 3,
      wait: async () => { waits++ },
    })
    expect(waits).toBe(2)
  })

  it('fails closed when an owner outlives the bounded handoff window', async () => {
    await expect(reconnectSessionNats('sess-stuck', {
      socketPath: '/tmp/tinstar-nats-sess-stuck.sock',
      findPids: async () => [501],
      readOwnerTargets: () => [],
      kill: () => {},
      isAlive: () => true,
      timeoutMs: 0,
    })).rejects.toThrow('NATS channel-server processes did not exit: 501')
  })

  it('fails closed on a future owner protocol without removing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-nats-future-owner-'))
    const ownerLockPath = join(root, 'owner')
    mkdirSync(ownerLockPath)
    const ownerPath = join(ownerLockPath, 'owner.json')
    writeFileSync(ownerPath, JSON.stringify({
      version: 2,
      markerId: 'future-owner',
      launcher: { version: 2, pid: process.pid, processIdentity: 'future' },
      principal: { version: 2, pid: process.pid, processIdentity: 'future' },
    }))
    try {
      await expect(reconnectSessionNats('sess-future-owner', {
        socketPath: join(root, 'control.sock'), ownerLockPath, findPids: async () => [],
      })).rejects.toThrow('incompatible or malformed NATS MCP owner record')
      expect(existsSync(ownerPath)).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('fails closed on a future transition protocol without replacing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-nats-future-transition-'))
    const ownerLockPath = join(root, 'owner')
    const transitionPath = `${ownerLockPath}.transition`
    mkdirSync(transitionPath)
    const leasePath = join(transitionPath, 'lease.json')
    writeFileSync(leasePath, JSON.stringify({
      version: 2, token: 'future-transition', pid: process.pid, processIdentity: 'future',
    }))
    try {
      await expect(reconnectSessionNats('sess-future-transition', {
        socketPath: join(root, 'control.sock'), ownerLockPath, findPids: async () => [],
      })).rejects.toThrow('incompatible or malformed NATS MCP owner transition')
      expect(existsSync(leasePath)).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('fails closed on future incarnation eligibility without replacing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-nats-future-eligibility-'))
    const ownerLockPath = join(root, 'owner')
    const eligibilityPath = `${ownerLockPath}.eligibility.json`
    writeFileSync(eligibilityPath, JSON.stringify({ version: 2, incarnation: 'future' }))
    try {
      await expect(reconnectSessionNats('sess-future-eligibility', {
        socketPath: join(root, 'control.sock'),
        ownerLockPath,
        resetOwnerState: true,
        findPids: async () => [],
      })).rejects.toThrow('incompatible or malformed NATS MCP owner eligibility')
      expect(existsSync(eligibilityPath)).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('reapSessionNatsChannelServer', () => {
  it('targets the stable per-session control-socket path', async () => {
    const needles: string[] = []
    const sessionsDir = mkdtempSync(join(tmpdir(), 'tinstar-reap-test-sessions-'))
    mkdirSync(join(sessionsDir, 'standup'))
    try {
      const res = await reapSessionNatsChannelServer('standup', sessionsDir, {
        findPids: async (needle) => {
          needles.push(needle)
          return [4242]
        },
        kill: () => {},
        isAlive: () => false,
      })
      expect(needles).toEqual(['/tmp/tinstar-nats-standup.sock'])
      expect(res).toEqual({ sessionName: 'standup', killed: [4242] })
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })

  it('reaps an orphan without recreating an already-removed session directory', async () => {
    const sessionsDir = mkdtempSync(join(tmpdir(), 'tinstar-reap-removed-session-'))
    const removedSessionDir = join(sessionsDir, 'gone')
    try {
      const res = await reapSessionNatsChannelServer('gone', sessionsDir, {
        findPids: async () => [4343],
        kill: () => {},
        isAlive: () => false,
      })
      expect(res).toEqual({ sessionName: 'gone', killed: [4343] })
      expect(existsSync(removedSessionDir)).toBe(false)
    } finally {
      rmSync(sessionsDir, { recursive: true, force: true })
    }
  })
})

describe('filterChannelServerPids', () => {
  it('keeps channel processes and drops parents and reply-only launcher wrappers', () => {
    const cmdlines: Record<number, string> = {
      10: 'codex\0resume\0--last\0--control-socket\0/tmp/tinstar-nats-standup.sock',
      11: 'bun\0x\0nats-channel-mcp\0--control-socket\0/tmp/tinstar-nats-standup.sock',
      12: 'bun\0/tmp/bunx-…/nats-channel-mcp\0--control-socket\0/tmp/tinstar-nats-standup.sock',
      13: 'node\0/opt/tinstar/bin/nats-mcp-launcher.js\0--owner-lock\0/home/user/.config/tinstar/sessions/standup/nats-mcp-owner\0--\0bun\0x\0github:except-pass/nats-channel-mcp\0--control-socket\0/tmp/tinstar-nats-standup.sock',
    }
    expect(filterChannelServerPids([10, 11, 12, 13], (pid) => cmdlines[pid]!)).toEqual([11, 12])
  })

  it('skips PIDs whose cmdline disappears mid-scan', () => {
    expect(filterChannelServerPids([99], () => {
      throw Object.assign(new Error('gone'), { code: 'ENOENT' })
    })).toEqual([])
  })

  it('propagates command-line inspection failures', () => {
    expect(() => filterChannelServerPids([99], () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
    })).toThrow('permission denied')
  })
})

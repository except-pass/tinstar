import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../../infra/supervisor'

let tmp: string

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tinstar-sup-test-')) })
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(tmp, { recursive: true, force: true })
})

function shSupervisor(script: string, stateDir: string, name = 'fake') {
  const bin = join(tmp, `${name}.sh`)
  writeFileSync(bin, `#!/bin/sh\n${script}\n`)
  chmodSync(bin, 0o755)
  return new Supervisor({
    name,
    binaryPath: bin,
    args: [],
    stateDir,
    port: 9999,
    probe: async () => true,
  })
}

describe('Supervisor spawn + readiness', () => {
  it('spawns the child and reports ready when probe succeeds', async () => {
    const sup = shSupervisor(`sleep 5`, tmp)
    await sup.start()
    expect(sup.state).toBe('ready')
    expect(sup.pid).toBeGreaterThan(0)
    await sup.stop()
  })

  it('marks degraded if readiness probe never succeeds', async () => {
    const bin = join(tmp, 'fake.sh')
    writeFileSync(bin, `#!/bin/sh\nsleep 5\n`)
    chmodSync(bin, 0o755)
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: bin,
      args: [],
      stateDir: tmp,
      port: 9999,
      probe: async () => false,
      probeTimeoutMs: 500,
    })
    await sup.start()
    expect(sup.state).toBe('degraded')
    await sup.stop()
  })
})

import { spawn } from 'node:child_process'

describe('Supervisor adoption', () => {
  it('keeps an adopted process healthy when liveness probes are permission denied', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: 42, binaryPath: '/bin/sleep', binaryHash: '', port: 9999, startedAt: Date.now(),
    }))
    let stopping = false
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') {
        stopping = true
        return true
      }
      if (signal === 0) {
        throw Object.assign(
          new Error(stopping ? 'no such process' : 'operation not permitted'),
          { code: stopping ? 'ESRCH' : 'EPERM' },
        )
      }
      return true
    })
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      healthIntervalMs: 10,
    })

    await sup.start()

    expect(sup.pid).toBe(42)
    expect(sup.state).toBe('ready')
    expect(kill).toHaveBeenCalledWith(42, 0)
    const deadline = Date.now() + 1_000
    while (
      kill.mock.calls.filter(([, signal]) => signal === 0).length < 2
      && Date.now() < deadline
    ) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(
      kill.mock.calls.filter(([, signal]) => signal === 0).length,
      'health loop did not continue probing within 1s',
    ).toBeGreaterThan(1)
    expect(sup.pid).toBe(42)
    expect(sup.state).toBe('ready')
    await sup.stop()
  })

  it('rejects an unconfirmed stop without clearing the tracked pid or state file', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: 42, binaryPath: '/bin/sleep', binaryHash: '', port: 9999, startedAt: Date.now(),
    }))
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      shutdownGraceMs: 0,
      healthIntervalMs: 60_000,
    })
    await sup.start()

    await expect(sup.stop()).rejects.toThrow('fake process 42 did not stop')

    expect(sup.pid).toBe(42)
    expect(JSON.parse(readFileSync(join(tmp, 'fake.state.json'), 'utf-8'))).toMatchObject({ pid: 42 })
  })

  it('adopts a live pid recorded in the state file instead of spawning', async () => {
    // spawn a long-lived sleep out-of-band
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!

    // pre-seed state file
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid, binaryPath: '/bin/sleep', binaryHash: '', port: 9999, startedAt: Date.now(),
    }))

    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
    })
    await sup.start()
    expect(sup.pid).toBe(pid)
    expect(sup.state).toBe('ready')
    // do NOT call stop() — that would kill the out-of-band sleep. Instead, kill directly.
    try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
  })

  it('ignores a stale pidfile with a dead pid and spawns fresh', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: 999999, binaryPath: '/bin/sleep', binaryHash: '', port: 9999, startedAt: 0,
    }))
    const sup = shSupervisor('sleep 5', tmp)
    await sup.start()
    expect(sup.pid).not.toBe(999999)
    expect(sup.state).toBe('ready')
    await sup.stop()
  })

  it('ignores a malformed pidfile with a non-positive pid', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: -1, binaryPath: '/bin/sleep', binaryHash: '', port: 9999, startedAt: 0,
    }))
    const sup = shSupervisor('sleep 5', tmp)
    await sup.start()
    expect(sup.pid).toBeGreaterThan(0)
    expect(sup.state).toBe('ready')
    await sup.stop()
  })

  it('ignores a malformed pidfile whose pid exceeds the supported range', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: Number.MAX_SAFE_INTEGER,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: 0,
    }))
    const sup = shSupervisor('sleep 5', tmp)

    await sup.start()

    expect(sup.pid).toBeGreaterThan(0)
    expect(sup.pid).not.toBe(Number.MAX_SAFE_INTEGER)
    expect(sup.state).toBe('ready')
    await sup.stop()
  })
})

describe('Supervisor crash restart', () => {
  it('restarts the child on unexpected exit (within the retry budget)', async () => {
    const pids = new Set<number>()
    const bin = join(tmp, 'crashy.sh')
    writeFileSync(bin, `#!/bin/sh\nexit 1\n`)
    chmodSync(bin, 0o755)

    const sup = new Supervisor({
      name: 'crashy',
      binaryPath: bin,
      args: [],
      stateDir: tmp,
      port: 9999,
      probe: async () => { if (sup.pid) pids.add(sup.pid); return false },
      probeTimeoutMs: 2000,
      probeIntervalMs: 25,
      restartBackoffMs: 25,
      maxRestartsPerMinute: 3,
    })
    await sup.start()
    // Each restart uses a fresh OS pid; observing more than one proves the restart loop fired.
    expect(pids.size).toBeGreaterThan(1)
    expect(sup.state).toBe('degraded')
    await sup.stop()
  })
})

describe('Supervisor health loop', () => {
  it('detects a dead adopted process and fires onStateChange', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!

    writeFileSync(join(tmp, 'health.state.json'), JSON.stringify({
      pid, binaryPath: '/bin/sleep', binaryHash: '', port: 9999, startedAt: Date.now(),
    }))

    const stateChanges: string[] = []
    const sup = new Supervisor({
      name: 'health',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => {
        try { process.kill(pid, 0); return true } catch { return false }
      },
      expectedBinaryName: 'sleep',
      healthIntervalMs: 100,
      healthFailureThreshold: 1,
      maxRestartsPerMinute: 0,
      onStateChange: (_name, state) => { stateChanges.push(state) },
    })
    await sup.start()
    expect(sup.state).toBe('ready')

    process.kill(pid, 'SIGKILL')
    await new Promise((r) => setTimeout(r, 350))

    expect(sup.state).toBe('degraded')
    expect(stateChanges).toContain('degraded')
    await sup.stop()
  })

  it('respawns and recovers even after going degraded with a dead process (wedge fix)', async () => {
    // Repro of the wedge: a supervisor that reaches 'degraded' (probe failing)
    // and THEN loses its process used to sit forever — the health loop returned
    // on a dead pid without respawning. It must now respawn from degraded.
    const waitFor = async (pred: () => boolean, ms = 2000) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        if (pred()) return
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    let probeOk = true
    const bin = join(tmp, 'wedge.sh')
    writeFileSync(bin, '#!/bin/sh\nwhile true; do sleep 10; done\n')
    chmodSync(bin, 0o755)
    const sup = new Supervisor({
      name: 'wedge',
      binaryPath: bin,
      args: [],
      stateDir: tmp,
      port: 9998,
      probe: async () => probeOk,
      healthIntervalMs: 40,
      healthFailureThreshold: 1,
      restartBackoffMs: 10,
      maxRestartsPerMinute: 10,
    })
    await sup.start()
    expect(sup.state).toBe('ready')
    const firstPid = sup.pid

    // Drive to degraded while the process is still alive.
    probeOk = false
    await waitFor(() => sup.state === 'degraded')
    expect(sup.state).toBe('degraded')

    // Kill the process: now pid is dead AND state is degraded — the old wedge.
    process.kill(sup.pid, 'SIGKILL')
    probeOk = true

    // New behavior: health loop respawns from degraded and recovers to ready.
    await waitFor(() => sup.state === 'ready' && sup.pid !== firstPid)
    expect(sup.state).toBe('ready')
    expect(sup.pid).not.toBe(firstPid)
    await sup.stop()
  })

  it('recovers from degraded when probe passes again', async () => {
    let probeResult = true
    const stateChanges: string[] = []
    const sup = new Supervisor({
      name: 'recover',
      binaryPath: join(tmp, 'recover.sh'),
      args: [],
      stateDir: tmp,
      port: 9999,
      probe: async () => probeResult,
      healthIntervalMs: 50,
      healthFailureThreshold: 1,
      onStateChange: (_name, state) => { stateChanges.push(state) },
    })
    writeFileSync(join(tmp, 'recover.sh'), '#!/bin/sh\nwhile true; do sleep 10; done\n')
    chmodSync(join(tmp, 'recover.sh'), 0o755)

    await sup.start()
    expect(sup.state).toBe('ready')

    probeResult = false
    await new Promise((r) => setTimeout(r, 150))
    expect(sup.state).toBe('degraded')

    probeResult = true
    await new Promise((r) => setTimeout(r, 150))
    expect(sup.state).toBe('ready')
    expect(stateChanges).toEqual(expect.arrayContaining(['ready', 'degraded', 'ready']))
    await sup.stop()
  })
})

describe('Supervisor graceful shutdown', () => {
  it('SIGTERMs the child and falls through to SIGKILL after grace', async () => {
    const bin = join(tmp, 'ignoring-term.sh')
    writeFileSync(bin, `#!/bin/sh\ntrap '' TERM\nwhile true; do sleep 10; done\n`)
    chmodSync(bin, 0o755)

    const sup = new Supervisor({
      name: 'ignoring',
      binaryPath: bin,
      args: [],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      shutdownGraceMs: 300,
    })
    await sup.start()
    const pidBefore = sup.pid
    await sup.stop()
    // kill(pid, 0) should fail (ESRCH) — the child is gone
    expect(() => process.kill(pidBefore, 0)).toThrow()
  })

  it('clears pid and child handles after stop so repeat stop is a no-op', async () => {
    const sup = shSupervisor('sleep 5', tmp)
    await sup.start()
    expect(sup.pid).toBeGreaterThan(0)
    await sup.stop()
    expect(sup.pid).toBe(0)
    // repeat stop must not throw or hang
    await sup.stop()
    expect(sup.pid).toBe(0)
  })
})

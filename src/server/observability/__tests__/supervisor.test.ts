import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../supervisor'

let tmp: string

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tinstar-sup-test-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

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

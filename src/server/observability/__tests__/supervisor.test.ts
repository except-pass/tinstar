import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getListeningProcessIds, Supervisor } from '../../infra/supervisor'
import { probeProcessLiveness, processIdentity } from '../../infra/process-liveness'

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

  it('refuses to signal or replace an unverified listener on the service port', async () => {
    const launched = join(tmp, 'launched')
    const bin = join(tmp, 'must-not-launch.sh')
    writeFileSync(bin, `#!/bin/sh\ntouch ${launched}\nsleep 5\n`)
    chmodSync(bin, 0o755)
    const kill = vi.spyOn(process, 'kill')
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: bin,
      args: [],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      listeningProcessIds: () => new Set([42]),
    })

    await expect(sup.start()).rejects.toThrow('refusing to replace an unverified listener')

    expect(existsSync(launched)).toBe(false)
    expect(kill).not.toHaveBeenCalled()
  })

  it('fails closed before spawning when listener ownership is unavailable', async () => {
    const launched = join(tmp, 'launched')
    const bin = join(tmp, 'must-not-launch.sh')
    writeFileSync(bin, `#!/bin/sh\ntouch ${launched}\nsleep 5\n`)
    chmodSync(bin, 0o755)
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: bin,
      args: [],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      listeningProcessIds: () => null,
    })

    await expect(sup.start()).rejects.toThrow('without proving the port is free')

    expect(existsSync(launched)).toBe(false)
    expect(sup.pid).toBe(0)
  })
})

describe('listener ownership inspection', () => {
  it('uses bounded ss inspection on Linux and parses listener pids', () => {
    const run = vi.fn(() => (
      'LISTEN 0 511 127.0.0.1:9999 0.0.0.0:* users:(("prometheus",pid=123,fd=8))\n'
      + 'LISTEN 0 511 [::1]:9999 [::]:* users:(("prometheus",pid=456,fd=9))\n'
    ))

    expect(getListeningProcessIds(9999, run, 'linux')).toEqual(new Set([123, 456]))
    expect(run).toHaveBeenCalledWith(
      'ss',
      ['-H', '-ltnp', 'sport = :9999'],
      { encoding: 'utf-8', timeout: 2_000 },
    )
  })

  it('falls back to bounded lsof inspection on Linux and uses it on macOS', () => {
    const linuxRun = vi.fn()
      .mockImplementationOnce(() => { throw Object.assign(new Error('ss missing'), { code: 'ENOENT' }) })
      .mockReturnValueOnce('p123\nf8\n')
    const darwinRun = vi.fn(() => 'p456\nf9\n')

    expect(getListeningProcessIds(9999, linuxRun, 'linux')).toEqual(new Set([123]))
    expect(linuxRun).toHaveBeenLastCalledWith(
      'lsof',
      ['-w', '-nP', '-iTCP:9999', '-sTCP:LISTEN', '-Fp'],
      { encoding: 'utf-8', timeout: 2_000 },
    )
    expect(getListeningProcessIds(9999, darwinRun, 'darwin')).toEqual(new Set([456]))
  })

  it('keeps a visible Linux listener inconclusive when neither tool reveals its pid', () => {
    const cleanMiss = Object.assign(new Error('no matches'), {
      status: 1,
      stdout: '',
      stderr: '',
      killed: false,
      signal: null,
    })
    const run = vi.fn()
      .mockReturnValueOnce('LISTEN 0 511 127.0.0.1:9999 0.0.0.0:*\n')
      .mockImplementationOnce(() => { throw cleanMiss })

    expect(getListeningProcessIds(9999, run, 'linux')).toBeNull()
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('distinguishes a clean empty match from unavailable or malformed failures', () => {
    const cleanMiss = Object.assign(new Error('no matches'), {
      status: 1,
      stdout: Buffer.from(''),
      stderr: Buffer.from(''),
      killed: false,
      signal: null,
    })
    const failed = Object.assign(new Error('lsof missing'), { code: 'ENOENT' })

    expect(getListeningProcessIds(9999, () => { throw cleanMiss }, 'darwin'))
      .toEqual(new Set())
    expect(getListeningProcessIds(9999, () => { throw failed }, 'darwin')).toBeNull()
    expect(getListeningProcessIds(9999, () => { throw null }, 'darwin')).toBeNull()
  })

  it('returns unknown without inspecting unsupported platforms', () => {
    const run = vi.fn(() => '')

    expect(getListeningProcessIds(9999, run, 'win32')).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })
})

import { spawn } from 'node:child_process'

describe('Supervisor adoption', () => {
  it('migrates a released-format state file after validating its executable and service', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: () => new Set([pid]),
    })

    await sup.start()

    expect(sup.pid).toBe(pid)
    expect(JSON.parse(readFileSync(join(tmp, 'fake.state.json'), 'utf-8')))
      .toMatchObject({ pid, processIdentity: expect.any(String) })
    await sup.stop()
  })

  it('migrates released-format state when listener inspection is unavailable', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    const onWarning = vi.fn()
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: () => null,
      onWarning,
    })

    await sup.start()

    expect(sup.pid).toBe(pid)
    expect(sup.state).toBe('ready')
    expect(onWarning).toHaveBeenCalledWith(
      'fake',
      expect.stringContaining('listener ownership for process'),
    )
    await sup.stop()
  })

  it('preserves released-format state when service validation fails', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!
    const stateFile = join(tmp, 'fake.state.json')
    writeFileSync(stateFile, JSON.stringify({
      pid,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => false,
      probeTimeoutMs: 50,
      probeIntervalMs: 10,
      expectedBinaryName: 'sleep',
      listeningProcessIds: () => new Set([pid]),
    })

    try {
      await expect(sup.start()).rejects.toThrow('could not be validated')
      await sup.stop()
      expect(existsSync(stateFile)).toBe(true)
      expect(JSON.parse(readFileSync(stateFile, 'utf-8'))).not.toHaveProperty('processIdentity')
    } finally {
      try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('refuses released-format state whose executable does not match', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!
    const stateFile = join(tmp, 'fake.state.json')
    writeFileSync(stateFile, JSON.stringify({
      pid,
      binaryPath: '/bin/false',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
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

    try {
      await expect(sup.start()).rejects.toThrow('executable does not match')
      await sup.stop()
      expect(existsSync(stateFile)).toBe(true)
      expect(JSON.parse(readFileSync(stateFile, 'utf-8'))).not.toHaveProperty('processIdentity')
    } finally {
      try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('refuses released-format state when the pid lifetime changes during validation', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!
    const stateFile = join(tmp, 'fake.state.json')
    writeFileSync(stateFile, JSON.stringify({
      pid,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    let identityRead = 0
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      processIdentity: () => ++identityRead === 1 ? 'process-a' : 'process-b',
      listeningProcessIds: () => new Set([pid]),
    })

    try {
      await expect(sup.start()).rejects.toThrow('could not be validated')
      await sup.stop()
      expect(existsSync(stateFile)).toBe(true)
      expect(JSON.parse(readFileSync(stateFile, 'utf-8'))).not.toHaveProperty('processIdentity')
    } finally {
      try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('refuses released-format state when another pid owns its service port', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!
    const stateFile = join(tmp, 'fake.state.json')
    writeFileSync(stateFile, JSON.stringify({
      pid,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: () => new Set([pid + 1]),
    })

    try {
      await expect(sup.start()).rejects.toThrow('does not own the recorded service port')
      await sup.stop()
      expect(JSON.parse(readFileSync(stateFile, 'utf-8'))).not.toHaveProperty('processIdentity')
    } finally {
      try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('rechecks released-format service ownership after readiness validation', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!
    const stateFile = join(tmp, 'fake.state.json')
    writeFileSync(stateFile, JSON.stringify({
      pid,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    let ownershipRead = 0
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: () => new Set([ownershipRead++ === 0 ? pid : pid + 1]),
    })

    try {
      await expect(sup.start()).rejects.toThrow('could not be validated')
      await sup.stop()
      expect(JSON.parse(readFileSync(stateFile, 'utf-8'))).not.toHaveProperty('processIdentity')
    } finally {
      try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('refuses to adopt a pre-boot-id Linux identity after a possible reboot', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid,
      processIdentity: 'linux:424242',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      processIdentity: () => 'linux:boot-a:424242',
    })

    try {
      await expect(sup.start()).rejects.toThrow('without a boot-scoped lifetime identity')
      expect(sup.pid).toBe(0)
      expect(sup.state).toBe('degraded')
    } finally {
      try { process.kill(pid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('spawns when a released-format pid now belongs to a different binary', async () => {
    const oldChild = spawn('tail', ['-f', '/dev/null'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: oldPid,
      binaryPath: '/usr/bin/tail',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['5'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
    })

    try {
      await sup.start()
      expect(sup.pid).not.toBe(oldPid)
      expect(sup.state).toBe('ready')
      await sup.stop()
    } finally {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('retires a proven released-format service before moving it to a new port', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: oldPid,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    }))
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['5'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: port => port === 1234 ? new Set([oldPid]) : new Set(),
    })

    try {
      await sup.start()
      expect(sup.pid).not.toBe(oldPid)
      expect(sup.state).toBe('ready')
      expect(probeProcessLiveness(oldPid).state).toBe('gone')
      await sup.stop()
    } finally {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('fails closed when prior-port ownership cannot be inspected', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    const stateFile = join(tmp, 'fake.state.json')
    const originalState = JSON.stringify({
      pid: oldPid,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    })
    writeFileSync(stateFile, originalState)
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['5'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: () => null,
    })

    try {
      await expect(sup.start()).rejects.toThrow('listener ownership could not be inspected')
      expect(sup.pid).toBe(0)
      expect(sup.state).toBe('degraded')
      expect(readFileSync(stateFile, 'utf-8')).toBe(originalState)
      await sup.stop()
    } finally {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('retires current-format state before moving its service to a new port', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    const oldIdentity = processIdentity(oldPid)
    expect(oldIdentity).not.toBeNull()
    const stateFile = join(tmp, 'fake.state.json')
    writeFileSync(stateFile, JSON.stringify({
      pid: oldPid,
      processIdentity: oldIdentity,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    }))
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['5'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: port => port === 1234 ? new Set([oldPid]) : new Set(),
    })

    try {
      await sup.start()
      expect(sup.pid).not.toBe(oldPid)
      expect(sup.state).toBe('ready')
      expect(probeProcessLiveness(oldPid).state).toBe('gone')
      await sup.stop()
    } finally {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('does not retire current-format state without prior-port ownership proof', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    const oldIdentity = processIdentity(oldPid)
    expect(oldIdentity).not.toBeNull()
    const stateFile = join(tmp, 'fake.state.json')
    const originalState = JSON.stringify({
      pid: oldPid,
      processIdentity: oldIdentity,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    })
    writeFileSync(stateFile, originalState)
    const kill = vi.spyOn(process, 'kill')
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['5'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: () => null,
    })

    try {
      await expect(sup.start()).rejects.toThrow('listener ownership could not be inspected')
      expect(sup.pid).toBe(0)
      expect(sup.state).toBe('degraded')
      expect(readFileSync(stateFile, 'utf-8')).toBe(originalState)
      expect(kill).not.toHaveBeenCalledWith(oldPid, 'SIGTERM')
      expect(kill).not.toHaveBeenCalledWith(oldPid, 'SIGKILL')
    } finally {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('refuses to duplicate a live current-format process with no proven listener', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    const oldIdentity = processIdentity(oldPid)
    expect(oldIdentity).not.toBeNull()
    const stateFile = join(tmp, 'fake.state.json')
    const originalState = JSON.stringify({
      pid: oldPid,
      processIdentity: oldIdentity,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    })
    writeFileSync(stateFile, originalState)
    const kill = vi.spyOn(process, 'kill')
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['5'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: () => new Set(),
    })

    try {
      await expect(sup.start()).rejects.toThrow('refusing to spawn while it is live')
      expect(sup.pid).toBe(0)
      expect(sup.state).toBe('degraded')
      expect(readFileSync(stateFile, 'utf-8')).toBe(originalState)
      expect(kill).not.toHaveBeenCalledWith(oldPid, 'SIGTERM')
      expect(kill).not.toHaveBeenCalledWith(oldPid, 'SIGKILL')
    } finally {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('fails closed when configured-port ownership becomes uninspectable', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    const oldIdentity = processIdentity(oldPid)
    expect(oldIdentity).not.toBeNull()
    const stateFile = join(tmp, 'fake.state.json')
    const originalState = JSON.stringify({
      pid: oldPid,
      processIdentity: oldIdentity,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    })
    writeFileSync(stateFile, originalState)
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['5'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: port => port === 1234 ? new Set() : null,
    })

    try {
      await expect(sup.start()).rejects.toThrow(
        'configured-port ownership could not be inspected',
      )
      expect(sup.pid).toBe(0)
      expect(sup.state).toBe('degraded')
      expect(readFileSync(stateFile, 'utf-8')).toBe(originalState)
    } finally {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('refuses to duplicate a live released-format process after a port change', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    const stateFile = join(tmp, 'fake.state.json')
    const originalState = JSON.stringify({
      pid: oldPid,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    })
    writeFileSync(stateFile, originalState)
    const kill = vi.spyOn(process, 'kill')
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['5'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: () => new Set(),
    })

    try {
      await expect(sup.start()).rejects.toThrow('refusing to spawn while it is live')
      expect(sup.pid).toBe(0)
      expect(sup.state).toBe('degraded')
      expect(readFileSync(stateFile, 'utf-8')).toBe(originalState)
      expect(kill).not.toHaveBeenCalledWith(oldPid, 'SIGTERM')
      expect(kill).not.toHaveBeenCalledWith(oldPid, 'SIGKILL')
    } finally {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('adopts a released-format process already serving the configured port', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    const oldIdentity = processIdentity(oldPid)
    expect(oldIdentity).not.toBeNull()
    const stateFile = join(tmp, 'fake.state.json')
    writeFileSync(stateFile, JSON.stringify({
      pid: oldPid,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    }))
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: port => port === 9999 ? new Set([oldPid]) : new Set(),
    })

    try {
      await sup.start()
      expect(sup.pid).toBe(oldPid)
      expect(sup.state).toBe('ready')
      expect(JSON.parse(readFileSync(stateFile, 'utf-8'))).toMatchObject({
        pid: oldPid,
        processIdentity: oldIdentity,
        port: 9999,
      })
      await sup.stop()
    } finally {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('does not migrate released-format configured-port state until the service is ready', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    const stateFile = join(tmp, 'fake.state.json')
    const originalState = JSON.stringify({
      pid: oldPid,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    })
    writeFileSync(stateFile, originalState)
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => false,
      probeTimeoutMs: 50,
      probeIntervalMs: 10,
      expectedBinaryName: 'sleep',
      listeningProcessIds: port => port === 9999 ? new Set([oldPid]) : new Set(),
    })

    try {
      await expect(sup.start()).rejects.toThrow('could not be validated')
      expect(sup.pid).toBe(0)
      expect(sup.state).toBe('degraded')
      expect(readFileSync(stateFile, 'utf-8')).toBe(originalState)
    } finally {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('fails closed when released-format configured-port ownership is unavailable', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    const stateFile = join(tmp, 'fake.state.json')
    const originalState = JSON.stringify({
      pid: oldPid,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    })
    writeFileSync(stateFile, originalState)
    const kill = vi.spyOn(process, 'kill')
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['5'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: port => port === 1234 ? new Set() : null,
    })

    try {
      await expect(sup.start()).rejects.toThrow(
        'configured-port ownership could not be inspected',
      )
      expect(sup.pid).toBe(0)
      expect(sup.state).toBe('degraded')
      expect(readFileSync(stateFile, 'utf-8')).toBe(originalState)
      expect(kill).not.toHaveBeenCalledWith(oldPid, 'SIGTERM')
      expect(kill).not.toHaveBeenCalledWith(oldPid, 'SIGKILL')
    } finally {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('adopts a current-format process already serving the configured port', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    const oldIdentity = processIdentity(oldPid)
    expect(oldIdentity).not.toBeNull()
    const stateFile = join(tmp, 'fake.state.json')
    writeFileSync(stateFile, JSON.stringify({
      pid: oldPid,
      processIdentity: oldIdentity,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    }))
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      listeningProcessIds: port => port === 9999 ? new Set([oldPid]) : new Set(),
    })

    try {
      await sup.start()
      expect(sup.pid).toBe(oldPid)
      expect(sup.state).toBe('ready')
      expect(JSON.parse(readFileSync(stateFile, 'utf-8'))).toMatchObject({
        pid: oldPid,
        port: 9999,
      })
      await sup.stop()
    } finally {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('does not migrate configured-port state until the service is ready', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    const oldIdentity = processIdentity(oldPid)
    expect(oldIdentity).not.toBeNull()
    const stateFile = join(tmp, 'fake.state.json')
    writeFileSync(stateFile, JSON.stringify({
      pid: oldPid,
      processIdentity: oldIdentity,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    }))
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => false,
      probeTimeoutMs: 50,
      probeIntervalMs: 10,
      expectedBinaryName: 'sleep',
      listeningProcessIds: port => port === 9999 ? new Set([oldPid]) : new Set(),
    })

    try {
      await expect(sup.start()).rejects.toThrow('could not be validated')
      expect(sup.pid).toBe(0)
      expect(sup.state).toBe('degraded')
      expect(JSON.parse(readFileSync(stateFile, 'utf-8'))).toMatchObject({
        pid: oldPid,
        port: 1234,
      })
    } finally {
      try { process.kill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('revalidates a recorded process after retirement fails without emitting idle', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    const oldIdentity = processIdentity(oldPid)
    expect(oldIdentity).not.toBeNull()
    const stateFile = join(tmp, 'fake.state.json')
    writeFileSync(stateFile, JSON.stringify({
      pid: oldPid,
      processIdentity: oldIdentity,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    }))
    const realKill = process.kill.bind(process)
    let allowRetirement = false
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === oldPid && signal !== 0 && !allowRetirement) return true
      return realKill(pid, signal)
    })
    const stateChanges: string[] = []
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['5'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      shutdownGraceMs: 0,
      listeningProcessIds: port => port === 1234 ? new Set([oldPid]) : new Set(),
      onStateChange: (_name, state) => stateChanges.push(state),
    })

    try {
      await expect(sup.start()).rejects.toThrow('retry will revalidate it')
      expect(sup.pid).toBe(oldPid)
      expect(readFileSync(stateFile, 'utf-8')).toContain(`"pid":${oldPid}`)
      expect(stateChanges).not.toContain('idle')

      // The surrounding stack's failed-start cleanup must retain ownership
      // while the recorded process still refuses to stop.
      await expect(sup.stop()).rejects.toThrow('did not stop')
      expect(sup.pid).toBe(oldPid)
      expect(sup.state).toBe('degraded')
      expect(stateChanges).not.toContain('idle')

      allowRetirement = true
      await sup.start()
      expect(sup.pid).not.toBe(oldPid)
      expect(sup.state).toBe('ready')
      expect(stateChanges).not.toContain('idle')
      await sup.stop()
    } finally {
      try { realKill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('re-reads durable state when a failed retirement loses identity evidence', async () => {
    const oldChild = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    oldChild.unref()
    const oldPid = oldChild.pid!
    const stateFile = join(tmp, 'fake.state.json')
    writeFileSync(stateFile, JSON.stringify({
      pid: oldPid,
      processIdentity: 'process-a',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 1234,
      startedAt: Date.now(),
    }))
    const realKill = process.kill.bind(process)
    let identity: string | null = 'process-a'
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === oldPid && signal === 'SIGTERM') {
        identity = null
        return true
      }
      return realKill(pid, signal)
    })
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['5'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      shutdownGraceMs: 0,
      processIdentity: () => identity,
      listeningProcessIds: port => port === 1234 ? new Set([oldPid]) : new Set(),
    })

    try {
      await expect(sup.start()).rejects.toThrow('retry will revalidate it')
      expect(sup.pid).toBe(oldPid)

      await expect(sup.start()).rejects.toThrow('identity is unavailable')
      expect(sup.pid).toBe(0)
      expect(sup.state).toBe('degraded')
      expect(readFileSync(stateFile, 'utf-8')).toContain(`"pid":${oldPid}`)
    } finally {
      try { realKill(oldPid, 'SIGTERM') } catch { /* gone */ }
    }
  })

  it('does not adopt a new process that reused the recorded pid', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: 42,
      processIdentity: 'process-a',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    const bin = join(tmp, 'fake.sh')
    writeFileSync(bin, '#!/bin/sh\nsleep 5\n')
    chmodSync(bin, 0o755)
    const opts = {
      name: 'fake',
      binaryPath: bin,
      args: [],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      processIdentity: (pid: number) => pid === 42 ? 'process-b' : `spawned-${pid}`,
    } as ConstructorParameters<typeof Supervisor>[0] & {
      processIdentity: (pid: number) => string | null
    }
    const sup = new Supervisor(opts)

    await sup.start()

    expect(sup.pid).not.toBe(42)
    await sup.stop()
  })

  it('refuses to spawn when a recorded live process cannot be identified', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: 42,
      processIdentity: 'process-a',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    const launched = join(tmp, 'launched')
    const bin = join(tmp, 'must-not-launch.sh')
    writeFileSync(bin, `#!/bin/sh\ntouch ${launched}\nsleep 5\n`)
    chmodSync(bin, 0o755)
    vi.spyOn(process, 'kill').mockReturnValue(true)
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: bin,
      args: [],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      processIdentity: () => null,
    })

    await expect(sup.start()).rejects.toThrow(
      'names live process 42, but its identity is unavailable',
    )
    expect(sup.state).toBe('degraded')
    expect(existsSync(launched)).toBe(false)
  })

  it('keeps an adopted process healthy when liveness probes are permission denied', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: 42,
      processIdentity: 'process-42',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
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
      processIdentity: () => 'process-42',
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

  it('retains an unconfirmed stop until a later liveness check proves exit', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: 42,
      processIdentity: 'process-42',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    let processAlive = true
    let allowStop = false
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM' && allowStop) {
        processAlive = false
        return true
      }
      throw Object.assign(
        new Error(processAlive ? 'operation not permitted' : 'no such process'),
        { code: processAlive ? 'EPERM' : 'ESRCH' },
      )
    })
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      shutdownGraceMs: 0,
      healthIntervalMs: 10,
      processIdentity: () => processAlive ? 'process-42' : null,
    })
    await sup.start()

    await expect(sup.stop()).rejects.toThrow('fake process 42 did not stop')
    expect(sup.state).toBe('degraded')
    expect(sup.pid).toBe(42)
    expect(JSON.parse(readFileSync(join(tmp, 'fake.state.json'), 'utf-8'))).toMatchObject({ pid: 42 })

    await expect(sup.start()).resolves.toBeUndefined()
    expect(sup.state).toBe('ready')
    expect(sup.pid).toBe(42)

    allowStop = true
    await expect(sup.stop()).resolves.toBeUndefined()
    expect(sup.pid).toBe(0)
  })

  it('does not signal when process identity is unavailable before SIGTERM', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: 42,
      processIdentity: 'process-a',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    let identity: string | null = 'process-a'
    let alive = true
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 0) {
        if (alive) return true
        throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      }
      if (signal === 'SIGTERM') alive = false
      return true
    })
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      processIdentity: () => identity,
    })
    await sup.start()

    identity = null
    await expect(sup.stop()).rejects.toThrow('identity could not be verified')
    expect(kill).not.toHaveBeenCalledWith(42, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(42, 'SIGKILL')
    expect(sup.state).toBe('degraded')
    expect(sup.pid).toBe(42)

    identity = 'process-a'
    await expect(sup.stop()).resolves.toBeUndefined()
    expect(sup.state).toBe('idle')
  })

  it('does not signal when process identity becomes unavailable before SIGKILL', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: 42,
      processIdentity: 'process-a',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    let identity: string | null = 'process-a'
    let alive = true
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') identity = null
      if (signal === 0) {
        if (alive) return true
        throw Object.assign(new Error('gone'), { code: 'ESRCH' })
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
      shutdownGraceMs: 0,
      processIdentity: () => identity,
    })
    await sup.start()

    await expect(sup.stop()).rejects.toThrow('did not stop')
    expect(kill).toHaveBeenCalledWith(42, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(42, 'SIGKILL')
    expect(sup.state).toBe('degraded')
    expect(sup.pid).toBe(42)

    alive = false
    await expect(sup.stop()).resolves.toBeUndefined()
    expect(sup.state).toBe('idle')
  })

  it('never signals a replacement process when the pid identity changes before stop', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: 42,
      processIdentity: 'process-a',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    let identity = 'process-a'
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const opts = {
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      shutdownGraceMs: 0,
      processIdentity: () => identity,
    } as ConstructorParameters<typeof Supervisor>[0] & {
      processIdentity: (pid: number) => string | null
    }
    const sup = new Supervisor(opts)
    await sup.start()

    identity = 'process-b'
    await sup.stop()

    expect(kill).not.toHaveBeenCalledWith(42, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(42, 'SIGKILL')
    expect(sup.state).toBe('idle')
  })

  it('does not escalate to SIGKILL after the pid is reused during shutdown', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: 42,
      processIdentity: 'process-a',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    let identity = 'process-a'
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') identity = 'process-b'
      return true
    })
    const opts = {
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      shutdownGraceMs: 100,
      // Let the health loop observe the identity change and finish shutdown
      // while stop() is inside its grace-period drain.
      healthIntervalMs: 10,
      processIdentity: () => identity,
    } as ConstructorParameters<typeof Supervisor>[0] & {
      processIdentity: (pid: number) => string | null
    }
    const sup = new Supervisor(opts)
    await sup.start()

    await sup.stop()

    expect(kill).toHaveBeenCalledWith(42, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(42, 'SIGKILL')
    expect(sup.state).toBe('idle')
  })

  it('adopts a live pid recorded in the state file instead of spawning', async () => {
    // spawn a long-lived sleep out-of-band
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!

    // pre-seed state file
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid,
      processIdentity: 'process-identity',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))

    const sup = new Supervisor({
      name: 'fake',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      expectedBinaryName: 'sleep',
      processIdentity: () => 'process-identity',
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

  it('quarantines a state file with a non-positive pid on stop', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: -1, binaryPath: '/bin/sleep', binaryHash: '', port: 9999, startedAt: 0,
    }))
    const sup = shSupervisor('sleep 5', tmp)

    await expect(sup.start()).rejects.toThrow('unsupported process id')
    expect(sup.pid).toBe(0)
    expect(sup.state).toBe('degraded')
    await sup.stop()
    expect(existsSync(join(tmp, 'fake.state.json'))).toBe(false)
    expect(readdirSync(tmp).some(name => name.startsWith('fake.state.json.invalid-'))).toBe(true)
    await sup.start()
    expect(sup.state).toBe('ready')
    await sup.stop()
  })

  it('quarantines a state file whose pid exceeds the supported range on stop', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), JSON.stringify({
      pid: Number.MAX_SAFE_INTEGER,
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: 0,
    }))
    const sup = shSupervisor('sleep 5', tmp)

    await expect(sup.start()).rejects.toThrow('unsupported process id')

    expect(sup.pid).toBe(0)
    expect(sup.state).toBe('degraded')
    await sup.stop()
    expect(existsSync(join(tmp, 'fake.state.json'))).toBe(false)
    expect(readdirSync(tmp).some(name => name.startsWith('fake.state.json.invalid-'))).toBe(true)
  })

  it('quarantines an unreadable state file on stop', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), '{"pid":')
    const sup = shSupervisor('sleep 5', tmp)

    await expect(sup.start()).rejects.toThrow('is unreadable')

    expect(sup.pid).toBe(0)
    expect(sup.state).toBe('degraded')
    await sup.stop()
    expect(existsSync(join(tmp, 'fake.state.json'))).toBe(false)
    expect(readdirSync(tmp).some(name => name.startsWith('fake.state.json.invalid-'))).toBe(true)
  })

  it('finishes shutdown even when invalid-state quarantine fails', async () => {
    writeFileSync(join(tmp, 'fake.state.json'), '{"pid":')
    const sup = shSupervisor('sleep 5', tmp)
    await expect(sup.start()).rejects.toThrow('is unreadable')
    const quarantineError = Object.assign(new Error('quarantine denied'), { code: 'EACCES' })
    const quarantine = vi.spyOn(
      sup as unknown as { quarantineUnverifiedState: () => void },
      'quarantineUnverifiedState',
    ).mockImplementationOnce(() => { throw quarantineError })

    await expect(sup.stop()).rejects.toBe(quarantineError)

    expect(sup.state).toBe('idle')
    expect(sup.pid).toBe(0)

    await expect(sup.stop()).resolves.toBeUndefined()
    expect(quarantine).toHaveBeenCalledTimes(2)
    expect(readdirSync(tmp).some(name => name.startsWith('fake.state.json.invalid-'))).toBe(true)
  })

  it('does not quarantine a repaired state generation after validation fails', async () => {
    const stateFile = join(tmp, 'fake.state.json')
    writeFileSync(stateFile, '{"pid":')
    const sup = shSupervisor('sleep 5', tmp)

    await expect(sup.start()).rejects.toThrow('is unreadable')
    const repaired = JSON.stringify({
      pid: 1234,
      processIdentity: 'repaired-generation',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    })
    writeFileSync(stateFile, repaired)

    await sup.stop()

    expect(readFileSync(stateFile, 'utf-8')).toBe(repaired)
    expect(readdirSync(tmp).some(name => name.includes('.invalid-'))).toBe(false)
  })

  it('restores an interrupted quarantine before evaluating startup state', async () => {
    const stateFile = join(tmp, 'fake.state.json')
    const interrupted = `${stateFile}.quarantine-interrupted`
    writeFileSync(interrupted, '{"pid":')
    const launched = join(tmp, 'launched')
    const sup = shSupervisor(`touch ${launched}\nsleep 5`, tmp)

    await expect(sup.start()).rejects.toThrow('is unreadable')

    expect(existsSync(launched)).toBe(false)
    expect(existsSync(stateFile)).toBe(true)
    expect(existsSync(interrupted)).toBe(false)
    await sup.stop()
    expect(readdirSync(tmp).some(name => name.startsWith('fake.state.json.invalid-'))).toBe(true)
  })

  it('recovers deterministically from multiple interrupted quarantine generations', async () => {
    const stateFile = join(tmp, 'fake.state.json')
    writeFileSync(`${stateFile}.quarantine-100`, '{"pid":')
    writeFileSync(`${stateFile}.quarantine-200`, '{"pid":')
    const bin = join(tmp, 'fake.sh')
    writeFileSync(bin, '#!/bin/sh\nsleep 5\n')
    chmodSync(bin, 0o755)
    const sup = new Supervisor({
      name: 'fake',
      binaryPath: bin,
      args: [],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      listeningProcessIds: () => new Set(),
    })

    await expect(sup.start()).rejects.toThrow('is unreadable')
    expect(readdirSync(tmp).filter(name => name.includes('.quarantine-'))).toHaveLength(0)
    expect(readdirSync(tmp).filter(name => name.includes('.displaced-recovered-'))).toHaveLength(1)
    await sup.stop()
    await sup.start()
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

  it('cancels a pending crash restart when stopped during backoff', async () => {
    const bin = join(tmp, 'crash-once.sh')
    writeFileSync(bin, '#!/bin/sh\nexit 1\n')
    chmodSync(bin, 0o755)
    const sup = new Supervisor({
      name: 'cancel-restart',
      binaryPath: bin,
      args: [],
      stateDir: tmp,
      port: 9999,
      probe: async () => false,
      probeTimeoutMs: 100,
      probeIntervalMs: 10,
      restartBackoffMs: 250,
      maxRestartsPerMinute: 3,
    })

    await sup.start()
    await sup.stop()
    await new Promise(resolve => setTimeout(resolve, 350))

    expect(sup.state).toBe('idle')
    expect(sup.pid).toBe(0)
    expect(existsSync(join(tmp, 'cancel-restart.state.json'))).toBe(false)
  })
})

describe('Supervisor health loop', () => {
  it('treats a reused pid as the tracked process exiting', async () => {
    writeFileSync(join(tmp, 'reused.state.json'), JSON.stringify({
      pid: 42,
      processIdentity: 'process-a',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
    }))
    let identity = 'process-a'
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const opts = {
      name: 'reused',
      binaryPath: '/bin/sleep',
      args: ['30'],
      stateDir: tmp,
      port: 9999,
      probe: async () => true,
      healthIntervalMs: 10,
      maxRestartsPerMinute: 0,
      processIdentity: () => identity,
    } as ConstructorParameters<typeof Supervisor>[0] & {
      processIdentity: (pid: number) => string | null
    }
    const sup = new Supervisor(opts)
    await sup.start()

    identity = 'process-b'

    await vi.waitFor(() => expect(sup.state).toBe('degraded'))
    expect(kill).not.toHaveBeenCalledWith(42, 'SIGTERM')
    expect(kill).not.toHaveBeenCalledWith(42, 'SIGKILL')
    await sup.stop()
  })

  it('detects a dead adopted process and fires onStateChange', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    child.unref()
    const pid = child.pid!

    writeFileSync(join(tmp, 'health.state.json'), JSON.stringify({
      pid,
      processIdentity: 'process-identity',
      binaryPath: '/bin/sleep',
      binaryHash: '',
      port: 9999,
      startedAt: Date.now(),
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
      processIdentity: () => 'process-identity',
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

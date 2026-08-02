import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../../infra/supervisor'
import { log } from '../../logger'
import {
  legacyNatsManagerHasRunningHealthLoop,
  NatsManager,
  PROCESS_NATS_MANAGER_KEY,
  resetProcessNatsManagerForTests,
  startProcessNatsManager,
  stopProcessNatsManager,
} from '../nats-manager'

function installLegacyOwner(manager: NatsManager) {
  const owner: { manager: NatsManager; startPromise: Promise<void> | null } = {
    manager,
    startPromise: null,
  }
  const processGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown }
  processGlobal[PROCESS_NATS_MANAGER_KEY] = owner
  return owner
}

describe('NatsManager', () => {
  afterEach(async () => {
    await resetProcessNatsManagerForTests()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('starts as idle with default port 4222', () => {
    const mgr = new NatsManager()
    expect(mgr.state).toBe('idle')
    expect(mgr.url).toBe('nats://127.0.0.1:4222')
  })

  it('respects NATS_PORT env var', () => {
    vi.stubEnv('NATS_PORT', '4333')
    const mgr = new NatsManager()
    expect(mgr.url).toBe('nats://127.0.0.1:4333')
  })

  it('skips start when NATS_URL is set (external server)', async () => {
    vi.stubEnv('NATS_URL', 'nats://remote:4222')
    const mgr = new NatsManager()
    await mgr.start()
    expect(mgr.state).toBe('ready')
    expect(mgr.url).toBe('nats://remote:4222')
  })

  it('skips start in fast-sim mode', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    const mgr = new NatsManager()
    await mgr.start()
    expect(mgr.state).toBe('ready')
  })

  it('stop on an idle manager is a no-op', async () => {
    const mgr = new NatsManager()
    await mgr.stop()
    expect(mgr.state).toBe('idle')
  })

  it('contains cleanup failure from an incomplete prior supervisor', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    const mgr = new NatsManager()
    const staleStop = vi.fn(async () => { throw new Error('old stop failed') })
    Object.assign(mgr as unknown as Record<string, unknown>, {
      supervisor: { pid: 0, stop: staleStop },
      supervisorStarted: false,
    })

    await expect(mgr.start()).resolves.toBeUndefined()
    expect(mgr.state).toBe('degraded')
    await expect(mgr.start()).resolves.toBeUndefined()
    expect(mgr.state).toBe('ready')
    expect(staleStop).toHaveBeenCalledOnce()
  })

  it('retains an incomplete supervisor while its process may still be alive', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    vi.spyOn(process, 'kill').mockReturnValue(true)
    const mgr = new NatsManager()
    const staleSupervisor = {
      pid: 42,
      stop: vi.fn<() => Promise<void>>(),
    }
    staleSupervisor.stop
      .mockRejectedValueOnce(new Error('stop was not confirmed'))
      .mockImplementationOnce(async () => { staleSupervisor.pid = 0 })
    Object.assign(mgr as unknown as Record<string, unknown>, {
      supervisor: staleSupervisor,
      supervisorStarted: false,
    })

    await mgr.start()
    expect(mgr.state).toBe('degraded')
    await mgr.start()

    expect(mgr.state).toBe('ready')
    expect(staleSupervisor.stop).toHaveBeenCalledTimes(2)
  })

  it('retains an incomplete supervisor with an invalid pid after an unconfirmed stop', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    const mgr = new NatsManager()
    const staleSupervisor = {
      pid: Number.MAX_SAFE_INTEGER,
      stop: vi.fn<() => Promise<void>>(),
    }
    staleSupervisor.stop
      .mockRejectedValueOnce(new Error('stop was not confirmed'))
      .mockImplementationOnce(async () => { staleSupervisor.pid = 0 })
    Object.assign(mgr as unknown as Record<string, unknown>, {
      supervisor: staleSupervisor,
      supervisorStarted: false,
    })

    await mgr.start()
    expect(mgr.state).toBe('degraded')
    await mgr.start()

    expect(mgr.state).toBe('ready')
    expect(staleSupervisor.stop).toHaveBeenCalledTimes(2)
  })

  it('reuses one process manager across HMR generations until process shutdown', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    const start = vi.spyOn(NatsManager.prototype, 'start')
    const stop = vi.spyOn(NatsManager.prototype, 'stop')

    const first = await startProcessNatsManager()
    const replacement = await startProcessNatsManager()

    expect(replacement).toBe(first)
    expect(start).toHaveBeenCalledOnce()
    expect(stop).not.toHaveBeenCalled()

    await stopProcessNatsManager()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('retries degraded initialization without duplicating a recovered manager', async () => {
    const start = vi.spyOn(NatsManager.prototype, 'start')
      .mockImplementationOnce(async function (this: NatsManager) {
        this.state = 'degraded'
      })
      .mockImplementationOnce(async function (this: NatsManager) {
        this.state = 'ready'
      })

    const failed = await startProcessNatsManager()
    expect(failed.state).toBe('degraded')
    const recovered = await startProcessNatsManager()
    const reused = await startProcessNatsManager()

    expect(recovered).toBe(failed)
    expect(reused).toBe(recovered)
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('reuses a degraded manager whose supervisor is already self-healing', async () => {
    const start = vi.spyOn(NatsManager.prototype, 'start')
      .mockImplementationOnce(async function (this: NatsManager) {
        this.state = 'degraded'
      })
    vi.spyOn(NatsManager.prototype, 'hasSelfHealingSupervisor').mockReturnValue(true)

    const first = await startProcessNatsManager()
    const second = await startProcessNatsManager()

    expect(second).toBe(first)
    expect(start).toHaveBeenCalledOnce()
  })

  it('retries a degraded legacy manager with no supervisor capability or instance', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    const legacy = {
      state: 'degraded',
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    } as unknown as NatsManager
    installLegacyOwner(legacy)

    const recovered = await startProcessNatsManager()

    expect(recovered).not.toBe(legacy)
    expect(recovered.state).toBe('ready')
    expect(legacy.stop).toHaveBeenCalledOnce()
    expect(legacy.start).not.toHaveBeenCalled()
  })

  it('replaces a degraded legacy manager whose supervisor never started health', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    const legacy = {
      state: 'degraded',
      supervisor: { healthTimer: null },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    } as unknown as NatsManager
    installLegacyOwner(legacy)

    const recovered = await startProcessNatsManager()

    expect(recovered).not.toBe(legacy)
    expect(recovered.state).toBe('ready')
    expect(legacy.stop).toHaveBeenCalledOnce()
    expect(legacy.start).not.toHaveBeenCalled()
  })

  it('reuses a degraded legacy manager with a running supervisor health loop', async () => {
    const legacy = {
      state: 'degraded',
      supervisor: { healthTimer: {} },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    } as unknown as NatsManager
    installLegacyOwner(legacy)

    const first = await startProcessNatsManager()
    const second = await startProcessNatsManager()

    expect(first).toBe(legacy)
    expect(second).toBe(legacy)
    expect(legacy.stop).not.toHaveBeenCalled()
    expect(legacy.start).not.toHaveBeenCalled()
  })

  it('pins the legacy health-loop probe to a real Supervisor lifecycle', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'nats-manager-legacy-supervisor-'))
    const supervisor = new Supervisor({
      name: 'legacy-health-probe',
      binaryPath: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      stateDir,
      port: 0,
      probe: async () => true,
      shutdownGraceMs: 1_000,
      healthIntervalMs: 60_000,
    })
    const legacy = { state: 'degraded', supervisor } as unknown as NatsManager

    try {
      expect(legacyNatsManagerHasRunningHealthLoop(legacy)).toBe(false)
      await supervisor.start()
      expect(legacyNatsManagerHasRunningHealthLoop(legacy)).toBe(true)
      await supervisor.stop()
      expect(legacyNatsManagerHasRunningHealthLoop(legacy)).toBe(false)
    } finally {
      await supervisor.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('starts a fresh manager even when retiring a failed legacy manager rejects', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    const logError = vi.spyOn(log, 'error').mockImplementation(() => {})
    const legacy = {
      state: 'degraded',
      supervisor: { healthTimer: null, pid: 0 },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => { throw new Error('legacy stop failed') }),
    } as unknown as NatsManager
    installLegacyOwner(legacy)

    const recovered = await startProcessNatsManager()

    expect(recovered).not.toBe(legacy)
    expect(recovered.state).toBe('ready')
    expect(legacy.stop).toHaveBeenCalledOnce()
    expect(legacy.start).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'nats',
      'failed to retire legacy nats manager before retry: legacy stop failed',
    )
  })

  it('refuses a replacement when failed legacy retirement has an unknown supervisor shape', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    const start = vi.spyOn(NatsManager.prototype, 'start')
    const logError = vi.spyOn(log, 'error').mockImplementation(() => {})
    const legacy = {
      state: 'degraded',
      supervisor: { healthTimer: null },
      start: vi.fn(async () => {}),
      stop: vi.fn()
        .mockRejectedValueOnce(new Error('legacy stop failed'))
        .mockResolvedValue(undefined),
    } as unknown as NatsManager
    const owner = installLegacyOwner(legacy)

    await expect(startProcessNatsManager()).rejects.toThrow(
      'legacy nats manager retirement was not confirmed',
    )
    expect(owner.manager).toBe(legacy)
    expect(start).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith(
      'nats',
      'failed to retire legacy nats manager before retry: legacy stop failed; '
        + 'the legacy supervisor process identity is unknown',
    )
  })

  it('refuses a replacement when failed legacy retirement has an invalid numeric pid', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    const start = vi.spyOn(NatsManager.prototype, 'start')
    const legacy = {
      state: 'degraded',
      supervisor: { healthTimer: null, pid: Number.MAX_SAFE_INTEGER },
      start: vi.fn(async () => {}),
      stop: vi.fn()
        .mockRejectedValueOnce(new Error('legacy stop failed'))
        .mockResolvedValue(undefined),
    } as unknown as NatsManager
    const owner = installLegacyOwner(legacy)

    await expect(startProcessNatsManager()).rejects.toThrow(
      'broker process identity is invalid: unsupported process id',
    )
    expect(owner.manager).toBe(legacy)
    expect(start).not.toHaveBeenCalled()
  })

  it('replaces a failed legacy manager that never installed a supervisor', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    const legacy = {
      state: 'degraded',
      supervisor: null,
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => { throw new Error('legacy stop failed') }),
    } as unknown as NatsManager
    installLegacyOwner(legacy)

    const recovered = await startProcessNatsManager()

    expect(recovered).not.toBe(legacy)
    expect(recovered.state).toBe('ready')
  })

  it('treats permission-denied process probes as possibly alive', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    const start = vi.spyOn(NatsManager.prototype, 'start')
    const logError = vi.spyOn(log, 'error').mockImplementation(() => {})
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    const legacy = {
      state: 'degraded',
      supervisor: { healthTimer: null, pid: 42 },
      start: vi.fn(async () => {}),
      stop: vi.fn()
        .mockRejectedValueOnce(new Error('legacy stop failed'))
        .mockResolvedValue(undefined),
    } as unknown as NatsManager
    const owner = installLegacyOwner(legacy)

    await expect(startProcessNatsManager()).rejects.toThrow(
      'legacy nats manager retirement was not confirmed',
    )
    expect(owner.manager).toBe(legacy)
    expect(start).not.toHaveBeenCalled()
    expect(kill).toHaveBeenCalledWith(42, 0)
    expect(logError).toHaveBeenCalledWith(
      'nats',
      'failed to retire legacy nats manager before retry: legacy stop failed; '
        + 'broker process 42 liveness is unknown: process probe failed with EPERM',
    )
  })

  it('replaces a failed legacy manager when its process is definitively gone', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })
    const legacy = {
      state: 'degraded',
      supervisor: { healthTimer: null, pid: 42 },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => { throw new Error('legacy stop failed') }),
    } as unknown as NatsManager
    installLegacyOwner(legacy)

    const recovered = await startProcessNatsManager()

    expect(recovered).not.toBe(legacy)
    expect(recovered.state).toBe('ready')
  })

  it('refuses a replacement when failed legacy retirement may still own a broker', async () => {
    vi.stubEnv('TINSTAR_FAST_SIM', '1')
    const supervisor = { healthTimer: null, pid: process.pid }
    const stop = vi.fn()
      .mockRejectedValueOnce(new Error('legacy stop failed'))
      .mockImplementationOnce(async () => { supervisor.pid = 0 })
    const legacy = {
      state: 'degraded',
      supervisor,
      start: vi.fn(async () => {}),
      stop,
    } as unknown as NatsManager
    const owner = installLegacyOwner(legacy)

    await expect(startProcessNatsManager()).rejects.toThrow(
      'legacy nats manager retirement was not confirmed',
    )
    expect(owner.manager).toBe(legacy)

    const recovered = await startProcessNatsManager()
    expect(recovered).not.toBe(legacy)
    expect(recovered.state).toBe('ready')
    expect(stop).toHaveBeenCalledTimes(2)
  })
})

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Supervisor } from '../../infra/supervisor'
import {
  legacyNatsManagerHasRunningHealthLoop,
  NatsManager,
  resetProcessNatsManagerForTests,
  startProcessNatsManager,
  stopProcessNatsManager,
} from '../nats-manager'

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
      supervisor: { stop: staleStop },
      supervisorStarted: false,
    })

    await expect(mgr.start()).resolves.toBeUndefined()
    expect(mgr.state).toBe('degraded')
    await expect(mgr.start()).resolves.toBeUndefined()
    expect(mgr.state).toBe('ready')
    expect(staleStop).toHaveBeenCalledOnce()
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
    const processGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown }
    processGlobal[Symbol.for('tinstar.nats-manager-owner.v1')] = {
      manager: legacy,
      startPromise: null,
    }

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
    const processGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown }
    processGlobal[Symbol.for('tinstar.nats-manager-owner.v1')] = {
      manager: legacy,
      startPromise: null,
    }

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
    const processGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown }
    processGlobal[Symbol.for('tinstar.nats-manager-owner.v1')] = {
      manager: legacy,
      startPromise: null,
    }

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
    const legacy = {
      state: 'degraded',
      supervisor: { healthTimer: null },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => { throw new Error('legacy stop failed') }),
    } as unknown as NatsManager
    const processGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown }
    processGlobal[Symbol.for('tinstar.nats-manager-owner.v1')] = {
      manager: legacy,
      startPromise: null,
    }

    const recovered = await startProcessNatsManager()

    expect(recovered).not.toBe(legacy)
    expect(recovered.state).toBe('ready')
    expect(legacy.stop).toHaveBeenCalledOnce()
  })
})

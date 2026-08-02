import { describe, it, expect, afterEach, vi } from 'vitest'
import {
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
    const mgr = new NatsManager()
    Object.assign(mgr as unknown as Record<string, unknown>, {
      supervisor: { stop: vi.fn(async () => { throw new Error('old stop failed') }) },
      supervisorStarted: false,
    })

    await expect(mgr.start()).resolves.toBeUndefined()
    expect(mgr.state).toBe('degraded')
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
    const legacy = {
      state: 'degraded',
      start: vi.fn(async function (this: { state: string }) { this.state = 'ready' }),
      stop: vi.fn(async () => {}),
    } as unknown as NatsManager
    const processGlobal = globalThis as typeof globalThis & { [key: symbol]: unknown }
    processGlobal[Symbol.for('tinstar.nats-manager-owner.v1')] = {
      manager: legacy,
      startPromise: null,
    }

    const recovered = await startProcessNatsManager()

    expect(recovered).toBe(legacy)
    expect(legacy.start).toHaveBeenCalledOnce()
  })

  it('reuses a degraded legacy manager that already owns a supervisor', async () => {
    const legacy = {
      state: 'degraded',
      supervisor: {},
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
    expect(legacy.start).not.toHaveBeenCalled()
  })
})

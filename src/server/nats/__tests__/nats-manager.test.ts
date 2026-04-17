import { describe, it, expect, afterEach, vi } from 'vitest'
import { NatsManager } from '../nats-manager'

describe('NatsManager', () => {
  afterEach(() => { vi.unstubAllEnvs() })

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
})

// @vitest-environment node
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest'
import { NatsTrafficBridge } from '../nats-traffic'
import { bounceNatsTraffic } from '../api/natsTrafficBounce'

// Mock the nats package — we never want a real broker for these tests.
vi.mock('nats', () => {
  const subscribers: Array<{ subject: string; sub: { unsubscribe: () => void } }> = []
  const fakeNc = {
    subscribe: vi.fn((subject: string) => {
      const sub = {
        unsubscribe: vi.fn(),
        // Make `for await` immediately complete (no messages)
        [Symbol.asyncIterator]: async function* () { /* yield nothing */ },
      }
      subscribers.push({ subject, sub: sub as any })
      return sub
    }),
    publish: vi.fn(),
    drain: vi.fn(async () => {}),
    closed: vi.fn(() => new Promise(() => { /* never resolves */ })),
  }
  return {
    connect: vi.fn(async () => fakeNc),
    StringCodec: () => ({
      encode: (s: string) => new TextEncoder().encode(s),
      decode: (b: Uint8Array) => new TextDecoder().decode(b),
    }),
    __fakeNc: fakeNc,
    __subscribers: subscribers,
  }
})

const fakeSse = { broadcastEvent: vi.fn() } as any

describe('NatsTrafficBridge.start() re-syncs subscriptions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('re-subscribes to known widget subjects on start() after a stop()', async () => {
    const bridge = new NatsTrafficBridge(fakeSse)
    await bridge.start()
    bridge.updateWidgetSubscriptions('saloon:alpha', ['tinstar.a.b', 'tinstar.c.d'])
    const nats = await import('nats') as any
    const subjectsBefore = nats.__fakeNc.subscribe.mock.calls.map((c: any[]) => c[0])
    expect(subjectsBefore).toEqual(expect.arrayContaining(['tinstar.a.b', 'tinstar.c.d']))

    await bridge.stop()
    // Reset the subscribe spy so we can observe re-subscribe on next start()
    nats.__fakeNc.subscribe.mockClear()

    await bridge.start()
    const subjectsAfter = nats.__fakeNc.subscribe.mock.calls.map((c: any[]) => c[0])
    expect(subjectsAfter).toEqual(expect.arrayContaining(['tinstar.a.b', 'tinstar.c.d']))
  })

  it('drains a connection that finishes opening after the bridge was stopped', async () => {
    const nats = await import('nats') as any
    let releaseConnect!: (connection: typeof nats.__fakeNc) => void
    const connectGate = new Promise<typeof nats.__fakeNc>(resolve => {
      releaseConnect = resolve
    })
    nats.connect.mockImplementationOnce(() => connectGate)
    const bridge = new NatsTrafficBridge(fakeSse)

    const starting = bridge.start()
    await Promise.resolve()
    await bridge.stop()
    releaseConnect(nats.__fakeNc)
    await starting

    expect(nats.connect).toHaveBeenCalledOnce()
    expect(nats.__fakeNc.drain).toHaveBeenCalledOnce()
    expect(bridge.status()).toEqual({ connection: 'down' })
  })

  it('keeps the newest connection across overlapping start-stop-start calls', async () => {
    const nats = await import('nats') as any
    const connection = () => ({
      ...nats.__fakeNc,
      drain: vi.fn(async () => {}),
      closed: vi.fn(() => new Promise(() => {})),
      isClosed: vi.fn(() => false),
    })
    const stale = connection()
    const current = connection()
    let releaseStale!: (connection: typeof stale) => void
    let releaseCurrent!: (connection: typeof current) => void
    const staleGate = new Promise<typeof stale>(resolve => { releaseStale = resolve })
    const currentGate = new Promise<typeof current>(resolve => { releaseCurrent = resolve })
    nats.connect
      .mockImplementationOnce(() => staleGate)
      .mockImplementationOnce(() => currentGate)
    const bridge = new NatsTrafficBridge(fakeSse)

    const staleStart = bridge.start()
    await bridge.stop()
    const currentStart = bridge.start()
    releaseCurrent(current)
    await currentStart
    releaseStale(stale)
    await staleStart

    expect(stale.drain).toHaveBeenCalledOnce()
    expect(current.drain).not.toHaveBeenCalled()
    expect(bridge.status()).toEqual({ connection: 'up' })
  })

  it('ignores stale closes after stop but reconnects the current generation', async () => {
    vi.useFakeTimers()
    const nats = await import('nats') as any
    const controlledConnection = () => {
      let close!: () => void
      const closed = new Promise<void>(resolve => { close = resolve })
      return {
        ...nats.__fakeNc,
        drain: vi.fn(async () => {}),
        closed: vi.fn(() => closed),
        isClosed: vi.fn(() => false),
        close,
      }
    }
    const stopped = controlledConnection()
    const current = controlledConnection()
    nats.connect
      .mockResolvedValueOnce(stopped)
      .mockResolvedValueOnce(current)
    const bridge = new NatsTrafficBridge(fakeSse)

    await bridge.start()
    await bridge.stop()
    stopped.close()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(nats.connect).toHaveBeenCalledOnce()

    await bridge.start()
    current.close()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(nats.connect).toHaveBeenCalledTimes(3)
  })

  it('ignores a replaced connection close while the current connection stays live', async () => {
    vi.useFakeTimers()
    const nats = await import('nats') as any
    const controlledConnection = () => {
      let close!: () => void
      const closed = new Promise<void>(resolve => { close = resolve })
      return {
        ...nats.__fakeNc,
        drain: vi.fn(async () => {}),
        closed: vi.fn(() => closed),
        isClosed: vi.fn(() => false),
        close,
      }
    }
    const replaced = controlledConnection()
    const current = controlledConnection()
    nats.connect
      .mockResolvedValueOnce(replaced)
      .mockResolvedValueOnce(current)
    const bridge = new NatsTrafficBridge(fakeSse)

    await bridge.start()
    await bridge.start()
    replaced.close()
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(5_000)

    expect(nats.connect).toHaveBeenCalledTimes(2)
    expect(bridge.status()).toEqual({ connection: 'up' })
  })
})

describe('bounceNatsTraffic(bridge)', () => {
  it('throws BRIDGE_UNAVAILABLE when bridge is undefined', async () => {
    await expect(bounceNatsTraffic(undefined)).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' })
  })

  it('calls stop() then start() in order on the bridge', async () => {
    const order: string[] = []
    const bridge = {
      stop: vi.fn(async () => { order.push('stop') }),
      start: vi.fn(async () => { order.push('start') }),
    }
    await bounceNatsTraffic(bridge as any)
    expect(order).toEqual(['stop', 'start'])
  })

  it('wraps a stop() failure as BOUNCE_FAILED with the original message', async () => {
    const bridge = {
      stop: vi.fn(async () => { throw new Error('nope') }),
      start: vi.fn(async () => {}),
    }
    await expect(bounceNatsTraffic(bridge as any)).rejects.toMatchObject({
      code: 'BOUNCE_FAILED',
      message: expect.stringContaining('nope'),
    })
  })

  it('wraps a start() failure as BOUNCE_FAILED with the original message', async () => {
    const bridge = {
      stop: vi.fn(async () => {}),
      start: vi.fn(async () => { throw new Error('connect refused') }),
    }
    await expect(bounceNatsTraffic(bridge as any)).rejects.toMatchObject({
      code: 'BOUNCE_FAILED',
      message: expect.stringContaining('connect refused'),
    })
  })
})

// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NatsTrafficBridge } from '../nats-traffic'

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
})

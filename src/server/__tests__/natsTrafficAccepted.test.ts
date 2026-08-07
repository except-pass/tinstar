import { describe, expect, it, vi } from 'vitest'
import type { SSEBroadcaster } from '../api/sse'
import { NatsTrafficBridge } from '../nats-traffic'

describe('NatsTrafficBridge accepted outbound projection', () => {
  it('preserves Saloon observability without publishing on the broker', () => {
    const sse = {
      broadcastEvent: vi.fn(),
    } as unknown as SSEBroadcaster
    const bridge = new NatsTrafficBridge(sse)

    bridge.recordAcceptedOutbound(
      'tinstar.space.project.worktree.receiver',
      'accepted message',
      'sender',
    )

    expect(sse.broadcastEvent).toHaveBeenCalledWith(
      'nats_traffic',
      expect.objectContaining({
        subject: 'tinstar.space.project.worktree.receiver',
        data: 'accepted message',
        direction: 'outbound',
        sender: 'sender',
      }),
    )
    expect(bridge).not.toHaveProperty('publish')
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { TinstarConfig } from '../../sessions/config'
import { createDefaultProviderRegistry } from '../lifecycle'
import { registerCodexDelivery } from '../codex-delivery-wiring'

describe('Codex production delivery wiring', () => {
  it('registers Codex on the shared provider registry and submits through tmux input', async () => {
    const registry = createDefaultProviderRegistry()
    const config = {
      dirs: { sessions: '/tmp/tinstar-sessions' },
      sessions: { prefix: 'tinstar-' },
    } as TinstarConfig
    const submitPrompt = vi.fn(async (
      _prompt: string,
      beforeEnter: () => Promise<boolean>,
    ) => beforeEnter())
    const withSessionInput = vi.fn(async (_config, _sessionId, operation) => operation({
      captureScreen: async () => '› Add a follow-up\n  ? for shortcuts',
      submitPrompt,
    }))

    registerCodexDelivery(registry, config, {
      withSessionInput,
      getAgentIdentity: vi.fn(async () => 'worker-v1'),
      captureScreen: vi.fn(async () => ''),
      tmuxName: vi.fn(() => 'tinstar-worker'),
      getSession: vi.fn(() => null),
    })

    const delivery = registry.deliveryFor('codex')
    expect(delivery).not.toBeNull()
    const result = await delivery!.accept({
      messageId: 'msg-1',
      deliveryId: 'delivery-1',
      attempt: 1,
      acceptedAt: '2026-08-01T12:00:00.000Z',
      sender: { sessionId: 'sender', incarnation: 'sender-v1' },
      destination: { subject: 'agents.worker.inbox' },
      recipient: {
        providerId: 'codex',
        sessionId: 'worker',
        incarnation: 'worker-v1',
      },
      text: 'hello from the durable dispatcher',
    })

    expect(result).toMatchObject({ state: 'accepted', providerId: 'codex' })
    expect(withSessionInput).toHaveBeenCalledWith(config, 'worker', expect.any(Function))
    expect(submitPrompt).toHaveBeenCalledTimes(1)
  })
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TinstarConfig } from '../../sessions/config'
import type { Session } from '../../sessions/session'
import { createDefaultProviderRegistry } from '../lifecycle'
import { registerCodexDelivery } from '../codex-delivery-wiring'

const { discoverCodexTranscript } = vi.hoisted(() => ({
  discoverCodexTranscript: vi.fn(),
}))
vi.mock('../../sessions/codex-transcript', async importOriginal => {
  const actual = await importOriginal<typeof import('../../sessions/codex-transcript')>()
  return { ...actual, discoverTranscript: discoverCodexTranscript }
})

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  discoverCodexTranscript.mockReset()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Codex production delivery wiring', () => {
  it('registers Codex on the shared provider registry and submits through tmux input', async () => {
    const registry = createDefaultProviderRegistry()
    const config = {
      dirs: { sessions: '/tmp/tinstar-sessions' },
      sessions: { prefix: 'tinstar-' },
    } as TinstarConfig
    let screen = '› Add a follow-up\n  ? for shortcuts'
    const captureScreen = vi.fn(async () => screen)
    const submitPrompt = vi.fn(async (
      prompt: string,
      beforeInput: () => Promise<boolean>,
      beforeEnter: () => Promise<void>,
    ) => {
      if (!await beforeInput()) return false
      screen = `› ${prompt}\n\n  gpt-5.6-sol xhigh`
      await beforeEnter()
      screen = '› Add a follow-up\n  ? for shortcuts'
      return true
    })
    const withSessionInput = vi.fn(async (_config, _sessionId, operation) => operation({
      captureScreen,
      getWorkingDirectory: async () => '/workspaces/project',
      getAgentIdentity: async () => 'worker-v1',
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

  it('confirms through the production session, tmux, and rollout mapping', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-delivery-wiring-'))
    roots.push(root)
    const transcriptPath = join(root, 'rollout.jsonl')
    const registry = createDefaultProviderRegistry()
    discoverCodexTranscript.mockResolvedValue(transcriptPath)
    const config = {
      dirs: { sessions: join(root, 'sessions') },
      sessions: { prefix: 'tinstar-' },
    } as TinstarConfig
    const session = {
      name: 'worker',
      created: '2026-08-01T12:00:00.000Z',
      workspace: { path: '/workspaces/project' },
    } as Session
    let submittedPrompt = ''
    let screen = '› Add a follow-up\n  ? for shortcuts'
    const captureScreen = vi.fn(async () => screen)
    const submitPrompt = vi.fn(async (
      prompt: string,
      beforeInput: () => Promise<boolean>,
      beforeEnter: () => Promise<void>,
    ) => {
      if (!await beforeInput()) return false
      submittedPrompt = prompt
      screen = `› ${prompt}\n\n  gpt-5.6-sol xhigh`
      await beforeEnter()
      screen = '› Add a follow-up\n  ? for shortcuts'
      return true
    })

    registerCodexDelivery(registry, config, {
      withSessionInput: vi.fn(async (_config, _sessionId, operation) => operation({
        captureScreen,
        getWorkingDirectory: async () => '/workspaces/project',
        getAgentIdentity: async () => 'worker-v1',
        submitPrompt,
      })),
      getAgentIdentity: vi.fn(async () => 'worker-v1'),
      captureScreen,
      tmuxName: vi.fn(() => 'tinstar-worker'),
      getSession: vi.fn(() => session),
    })

    const delivery = registry.deliveryFor('codex')!
    const accepted = await delivery.accept({
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
      text: 'confirm the production mapping',
    })
    if (accepted.state !== 'accepted') throw new Error('fixture was not accepted')
    writeFileSync(transcriptPath, `${JSON.stringify({
      timestamp: '2026-08-01T12:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: submittedPrompt },
    })}\n`)

    await expect(delivery.confirm!(accepted)).resolves.toMatchObject({
      state: 'confirmed',
      evidence: { source: { id: 'codex-rollout-user-message' } },
    })
    expect(discoverCodexTranscript).toHaveBeenCalledWith(
      'worker',
      '/workspaces/project',
      session.created,
      'tinstar-worker',
      captureScreen,
    )
  })

  it('confirms a standalone Codex session from its managed terminal directory without resubmitting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-delivery-standalone-'))
    roots.push(root)
    const transcriptPath = join(root, 'rollout.jsonl')
    const launchDirectory = '/tmp/tinstar-standalone-launch'
    const registry = createDefaultProviderRegistry()
    discoverCodexTranscript.mockResolvedValue(transcriptPath)
    const config = {
      dirs: { sessions: join(root, 'sessions') },
      sessions: { prefix: 'tinstar-' },
    } as TinstarConfig
    const session = {
      name: 'worker',
      created: '2026-08-01T12:00:00.000Z',
      workspace: { path: null },
    } as Session
    let submittedPrompt = ''
    let screen = '› Add a follow-up\n  ? for shortcuts'
    const captureScreen = vi.fn(async () => screen)
    const submitPrompt = vi.fn(async (
      prompt: string,
      beforeInput: () => Promise<boolean>,
      beforeEnter: () => Promise<void>,
    ) => {
      if (!await beforeInput()) return false
      submittedPrompt = prompt
      screen = `› ${prompt}\n\n  gpt-5.6-sol xhigh`
      await beforeEnter()
      screen = '› Add a follow-up\n  ? for shortcuts'
      return true
    })
    const getWorkingDirectory = vi.fn(async () => launchDirectory)

    registerCodexDelivery(registry, config, {
      withSessionInput: vi.fn(async (_config, _sessionId, operation) => operation({
        captureScreen,
        getWorkingDirectory,
        getAgentIdentity: async () => 'worker-v1',
        submitPrompt,
      })),
      getAgentIdentity: vi.fn(async () => 'worker-v1'),
      captureScreen,
      tmuxName: vi.fn(() => 'tinstar-worker'),
      getSession: vi.fn(() => session),
    })

    const delivery = registry.deliveryFor('codex')!
    const accepted = await delivery.accept({
      messageId: 'msg-1',
      deliveryId: 'delivery-1',
      attempt: 1,
      acceptedAt: '2026-08-01T12:00:00.000Z',
      sender: { sessionId: 'sender', incarnation: 'sender-v1' },
      destination: { subject: 'agents.worker.inbox' },
      recipient: { providerId: 'codex', sessionId: 'worker', incarnation: 'worker-v1' },
      text: 'confirm standalone rollout mapping',
    })
    if (accepted.state !== 'accepted') throw new Error('fixture was not accepted')
    writeFileSync(transcriptPath, `${JSON.stringify({
      timestamp: '2026-08-01T12:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: submittedPrompt },
    })}\n`)

    await expect(delivery.confirm!(accepted)).resolves.toMatchObject({
      state: 'confirmed',
      evidence: { source: { id: 'codex-rollout-user-message' } },
    })
    expect(getWorkingDirectory).toHaveBeenCalledWith()
    expect(discoverCodexTranscript).toHaveBeenCalledWith(
      'worker',
      launchDirectory,
      session.created,
      'tinstar-worker',
      expect.any(Function),
    )
    expect(submitPrompt).toHaveBeenCalledTimes(1)
  })

  it('releases standalone terminal input before rollout discovery scans', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-delivery-unlocked-discovery-'))
    roots.push(root)
    const registry = createDefaultProviderRegistry()
    const config = {
      dirs: { sessions: join(root, 'sessions') },
      sessions: { prefix: 'tinstar-' },
    } as TinstarConfig
    const session = {
      name: 'worker',
      created: '2026-08-01T12:00:00.000Z',
      workspace: { path: null },
    } as Session
    let resolveDiscovery: ((path: string | null) => void) | undefined
    discoverCodexTranscript.mockImplementationOnce(() => new Promise((resolve) => {
      resolveDiscovery = resolve
    }))
    let screen = '› Add a follow-up\n  ? for shortcuts'
    const submitPrompt = vi.fn(async (
      prompt: string,
      beforeInput: () => Promise<boolean>,
      beforeEnter: () => Promise<void>,
    ) => {
      if (!await beforeInput()) return false
      screen = `› ${prompt}\n\n  gpt-5.6-sol xhigh`
      await beforeEnter()
      screen = '› Add a follow-up\n  ? for shortcuts'
      return true
    })
    const input = {
      captureScreen: vi.fn(async () => screen),
      getWorkingDirectory: vi.fn(async () => '/workspaces/standalone'),
      getAgentIdentity: vi.fn(async () => 'worker-v1'),
      submitPrompt,
    }
    let inputTail: Promise<unknown> = Promise.resolve()
    const withSessionInput = vi.fn((_config, _sessionId, operation) => {
      const run = inputTail.catch(() => undefined).then(() => operation(input))
      inputTail = run
      return run
    })

    registerCodexDelivery(registry, config, {
      withSessionInput,
      getAgentIdentity: vi.fn(async () => 'worker-v1'),
      captureScreen: vi.fn(async () => ''),
      tmuxName: vi.fn(() => 'tinstar-worker'),
      getSession: vi.fn(() => session),
    })

    const delivery = registry.deliveryFor('codex')!
    const first = await delivery.accept({
      messageId: 'msg-1',
      deliveryId: 'delivery-1',
      attempt: 1,
      acceptedAt: '2026-08-01T12:00:00.000Z',
      sender: { sessionId: 'sender', incarnation: 'sender-v1' },
      destination: { subject: 'agents.worker.inbox' },
      recipient: { providerId: 'codex', sessionId: 'worker', incarnation: 'worker-v1' },
      text: 'first message',
    })
    if (first.state !== 'accepted') throw new Error('fixture was not accepted')

    const confirmation = delivery.confirm!(first)
    await vi.waitFor(() => expect(discoverCodexTranscript).toHaveBeenCalledOnce())

    // Discovery is still unresolved, but it no longer owns the tmux input
    // lock, so a live message can reach the same pinned terminal immediately.
    await expect(delivery.accept({
      messageId: 'msg-2',
      deliveryId: 'delivery-2',
      attempt: 1,
      acceptedAt: '2026-08-01T12:00:01.000Z',
      sender: { sessionId: 'sender', incarnation: 'sender-v1' },
      destination: { subject: 'agents.worker.inbox' },
      recipient: { providerId: 'codex', sessionId: 'worker', incarnation: 'worker-v1' },
      text: 'second message',
    })).resolves.toMatchObject({ state: 'accepted' })
    expect(submitPrompt).toHaveBeenCalledTimes(2)

    resolveDiscovery?.(null)
    await expect(confirmation).resolves.toMatchObject({ state: 'unobservable' })
  })
})

// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireBackendSingleton } from '../../infra/lock'
import { createDefaultProviderRegistry } from '../../providers/lifecycle'
import {
  createSession,
  setState,
  type Session,
} from '../../sessions'
import {
  acceptForManagedSessionRecipients,
  invalidatePersistedSessionBackendGenerationForConfig,
  persistedSessionBackendGenerationForConfig,
  resetSessionBackendOwnersForTests,
  type RouteContext,
} from '../../api/routes'
import type { TinstarConfig } from '../../sessions/config'
import {
  DeliveryLedger,
  deliveryLedgerPaths,
  type DeliveryAcceptInput,
} from '../delivery-ledger'
import {
  acceptForLiveRecipients,
  type LiveDeliveryDependencies,
  type LiveDeliveryRequest,
} from '../live-recipient-resolution'

const TASK = 'tinstar.space.init.epic.task'
const ROOM = 'tinstar.room.review-pair'

function managedSession(
  name: string,
  state: Session['state'] = 'running',
  subscriptions: string[] = [TASK, `${TASK}.${name}`],
  adapter = 'claude',
): Session {
  return {
    name,
    backend: 'tmux',
    state,
    project: null,
    workspace: { path: null, worktree: false, branch: null, basePath: null },
    conversation: { id: `${name}-conversation` },
    profile: null,
    oneshot: false,
    skipPermissions: true,
    background: false,
    blocked: false,
    cliTemplate: null,
    adapter,
    nats: { enabled: true, subscriptions },
    port: 9000,
    ttydPid: 100,
    natsControlOrphanedAt: null,
    appendSystemPrompt: null,
    agent: null,
    modelOverride: null,
    created: '2026-08-01T00:00:00.000Z',
    lastActive: '2026-08-01T00:00:00.000Z',
  }
}

function request(subject: string, requestId = 'req-live'): LiveDeliveryRequest {
  return {
    requestId,
    sender: { sessionId: 'sender', incarnation: 'sender-v1' },
    destination: { subject },
    text: 'Inspect the delivery boundary.',
  }
}

function dependencies(
  sessions: Session[],
  overrides: Partial<LiveDeliveryDependencies> = {},
): LiveDeliveryDependencies {
  const byName = new Map(sessions.map(session => [session.name, session]))
  return {
    coordinationKey: {},
    listSessions: vi.fn(async () => sessions),
    readSession: name => byName.get(name) ?? null,
    isDeleting: () => false,
    graveyardSessionNames: () => [],
    acquireLease: name => byName.has(name)
      ? { token: `${name}-generation`, release: () => {} }
      : null,
    leaseIsCurrent: () => true,
    observeProcess: vi.fn(async name => ({
      state: 'alive' as const,
      incarnation: `${name}-process`,
    })),
    providerIdFor: session => session.adapter ?? 'claude',
    replayAcceptance: vi.fn(async () => null),
    accept: vi.fn(async input => ({
      accepted: true as const,
      replayed: false,
      wrote: true as const,
      details: 'retained' as const,
      receipt: {
        requestId: input.requestId,
        messageId: 'msg-test',
        acceptedAt: '2026-08-01T00:00:01.000Z',
        deliveryIds: input.recipients.map((
          _recipient: DeliveryAcceptInput['recipients'][number],
          index: number,
        ) => `msg-test/d/${index + 1}`),
      },
      message: {
        id: 'msg-test',
        requestId: input.requestId,
        requestFingerprint: '0'.repeat(64),
        acceptedAt: '2026-08-01T00:00:01.000Z',
        sender: input.sender,
        destination: input.destination,
        text: input.text,
        deliveryIds: input.recipients.map((
          _recipient: DeliveryAcceptInput['recipients'][number],
          index: number,
        ) => `msg-test/d/${index + 1}`),
      },
      deliveries: [],
    })),
    ...overrides,
  }
}

describe('live delivery recipient resolution', () => {
  it('rejects malformed runtime requests before dereferencing or resolving', async () => {
    const deps = dependencies([])

    await expect(acceptForLiveRecipients(
      undefined as unknown as LiveDeliveryRequest,
      deps,
    )).resolves.toEqual({
      ok: false,
      error: { code: 'invalid-request', detail: 'request must be an object' },
    })
    await expect(acceptForLiveRecipients(
      { requestId: 'broken' } as unknown as LiveDeliveryRequest,
      deps,
    )).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid-request' },
    })
    expect(deps.listSessions).not.toHaveBeenCalled()
    expect(deps.replayAcceptance).not.toHaveBeenCalled()
    expect(deps.accept).not.toHaveBeenCalled()
  })

  it('replays a durable acceptance before consulting the changed live set', async () => {
    const deps = dependencies([])
    const accepted = await deps.accept({
      ...request(`${TASK}.agent-2`),
      recipients: [{
        providerId: 'claude',
        sessionId: 'agent-2',
        incarnation: 'agent-2-process',
      }],
    })
    expect(accepted.accepted).toBe(true)
    deps.listSessions = vi.fn(() => {
      throw new Error('live resolution must not run for a replay')
    })
    deps.replayAcceptance = vi.fn(async () => accepted)
    vi.mocked(deps.accept).mockClear()

    await expect(acceptForLiveRecipients(
      request(`${TASK}.agent-2`),
      deps,
    )).resolves.toMatchObject({
      ok: true,
      acceptance: { accepted: true },
    })
    expect(deps.listSessions).not.toHaveBeenCalled()
    expect(deps.accept).not.toHaveBeenCalled()
  })

  it('single-flights concurrent retries before their live sets can diverge', async () => {
    const deps = dependencies([managedSession('agent-2')])
    const originalAccept = deps.accept
    let acceptEntered!: () => void
    let releaseAccept!: () => void
    const atAccept = new Promise<void>(resolve => { acceptEntered = resolve })
    const accepting = new Promise<void>(resolve => { releaseAccept = resolve })
    deps.accept = vi.fn(async input => {
      acceptEntered()
      await accepting
      return originalAccept(input)
    })

    const first = acceptForLiveRecipients(request(`${TASK}.agent-2`), deps)
    await atAccept
    const retry = acceptForLiveRecipients(request(`${TASK}.agent-2`), deps)
    const conflicting = await acceptForLiveRecipients({
      ...request(`${TASK}.agent-2`),
      text: 'Different intent under the same request ID.',
    }, deps)

    expect(conflicting).toMatchObject({
      ok: false,
      error: {
        code: 'ledger-rejected',
        rejection: { reason: 'request-id-reuse' },
      },
    })
    releaseAccept()
    const [accepted, replayedConcurrent] = await Promise.all([first, retry])
    expect(accepted).toEqual(replayedConcurrent)
    expect(deps.listSessions).toHaveBeenCalledOnce()
    expect(deps.observeProcess).toHaveBeenCalledOnce()
    expect(deps.accept).toHaveBeenCalledOnce()
  })

  it('accepts a direct destination only for the named live subscriber', async () => {
    const target = managedSession('agent-2')
    const eavesdropper = managedSession('agent-3', 'running', [
      TASK,
      `${TASK}.agent-3`,
      `${TASK}.agent-2`,
    ])
    const deps = dependencies([target, eavesdropper])

    const result = await acceptForLiveRecipients(request(`${TASK}.agent-2`), deps)

    expect(result).toMatchObject({
      ok: true,
      destinationKind: 'dm',
      exclusions: [],
      acceptance: {
        accepted: true,
        message: { requestId: 'req-live' },
      },
    })
    expect(deps.accept).toHaveBeenCalledWith(expect.objectContaining({
      recipients: [{
        providerId: 'claude',
        sessionId: 'agent-2',
        incarnation: 'agent-2-process',
      }],
    }))
  })

  it.each([
    ['creating', 'not-started'],
    ['stopped', 'stopped'],
  ] as const)('rejects a direct %s session before ledger acceptance', async (
    state,
    reason,
  ) => {
    const deps = dependencies([managedSession('agent-2', state)])

    await expect(acceptForLiveRecipients(
      request(`${TASK}.agent-2`),
      deps,
    )).resolves.toEqual({
      ok: false,
      error: {
        code: 'recipient-unavailable',
        destinationKind: 'dm',
        subject: `${TASK}.agent-2`,
        exclusions: [{ sessionId: 'agent-2', reason }],
      },
    })
    expect(deps.accept).not.toHaveBeenCalled()
  })

  it('distinguishes missing and graveyarded direct destinations', async () => {
    const missing = dependencies([])
    await expect(acceptForLiveRecipients(
      request(`${TASK}.deleted-agent`, 'req-deleted'),
      missing,
    )).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'recipient-unavailable',
        exclusions: [{ sessionId: 'deleted-agent', reason: 'missing' }],
      },
    })

    const graveyarded = dependencies([], {
      graveyardSessionNames: () => ['retired-agent'],
    })
    await expect(acceptForLiveRecipients(
      request(`${TASK}.retired-agent`, 'req-graveyard'),
      graveyarded,
    )).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'recipient-unavailable',
        exclusions: [{ sessionId: 'retired-agent', reason: 'graveyarded' }],
      },
    })
    expect(missing.accept).not.toHaveBeenCalled()
    expect(graveyarded.accept).not.toHaveBeenCalled()
  })

  it.each([
    ['deleting', {
      isDeleting: () => true,
    }],
    ['process-dead', {
      observeProcess: async () => ({ state: 'dead' as const }),
    }],
  ] as const)('rejects a direct recipient that is %s', async (reason, override) => {
    const deps = dependencies([managedSession('agent-2')], override)

    await expect(acceptForLiveRecipients(
      request(`${TASK}.agent-2`),
      deps,
    )).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'recipient-unavailable',
        exclusions: [{ sessionId: 'agent-2', reason }],
      },
    })
    expect(deps.accept).not.toHaveBeenCalled()
  })

  it('snapshots live task subscribers and reports stopped and process-dead exclusions', async () => {
    const sessions = [
      managedSession('claude-live'),
      managedSession('codex-live', 'idle', [TASK, `${TASK}.codex-live`], 'codex'),
      managedSession('stopped-agent', 'stopped'),
      managedSession('dead-agent'),
      managedSession('other-task', 'running', ['tinstar.space.init.epic.other']),
    ]
    const deps = dependencies(sessions, {
      observeProcess: async name => name === 'dead-agent'
        ? { state: 'dead' }
        : { state: 'alive', incarnation: `${name}-process` },
    })

    const result = await acceptForLiveRecipients(request(TASK), deps)

    expect(result).toMatchObject({
      ok: true,
      destinationKind: 'broadcast',
      exclusions: [
        { sessionId: 'dead-agent', reason: 'process-dead' },
        { sessionId: 'stopped-agent', reason: 'stopped' },
      ],
    })
    expect(deps.accept).toHaveBeenCalledWith(expect.objectContaining({
      recipients: [
        {
          providerId: 'claude',
          sessionId: 'claude-live',
          incarnation: 'claude-live-process',
        },
        {
          providerId: 'codex',
          sessionId: 'codex-live',
          incarnation: 'codex-live-process',
        },
      ],
    }))
  })

  it('resolves breakout rooms from current live subscriptions', async () => {
    const member = managedSession('room-member', 'needs_attention', [
      `${TASK}.room-member`,
      ROOM,
    ])
    const outsider = managedSession('room-outsider')
    const deps = dependencies([member, outsider])

    const result = await acceptForLiveRecipients(request(ROOM), deps)

    expect(result).toMatchObject({
      ok: true,
      destinationKind: 'breakout',
      exclusions: [],
    })
    expect(deps.accept).toHaveBeenCalledWith(expect.objectContaining({
      recipients: [expect.objectContaining({ sessionId: 'room-member' })],
    }))
  })

  it('rejects an empty live broadcast set without touching the ledger', async () => {
    const deps = dependencies([
      managedSession('stopped-agent', 'stopped'),
      managedSession('dead-agent'),
    ], {
      observeProcess: async name => name === 'dead-agent'
        ? { state: 'dead' }
        : { state: 'alive', incarnation: `${name}-process` },
    })

    await expect(acceptForLiveRecipients(request(TASK), deps)).resolves.toEqual({
      ok: false,
      error: {
        code: 'empty-live-set',
        destinationKind: 'broadcast',
        subject: TASK,
        exclusions: [
          { sessionId: 'dead-agent', reason: 'process-dead' },
          { sessionId: 'stopped-agent', reason: 'stopped' },
        ],
      },
    })
    expect(deps.accept).not.toHaveBeenCalled()
  })

  it('holds the lifecycle lease from the definitive probe through acceptance', async () => {
    let held = false
    let releaseProbe!: () => void
    let probeEntered!: () => void
    const probing = new Promise<void>(resolve => { releaseProbe = resolve })
    const atProbe = new Promise<void>(resolve => { probeEntered = resolve })
    const deps = dependencies([managedSession('agent-2')], {
      acquireLease: () => {
        if (held) return null
        held = true
        return { token: 'generation-1', release: () => { held = false } }
      },
      observeProcess: async () => {
        expect(held).toBe(true)
        probeEntered()
        await probing
        return { state: 'alive', incarnation: 'agent-2-process' }
      },
      accept: vi.fn(async () => {
        expect(held).toBe(true)
        return { accepted: false as const, reason: 'capacity-exceeded' as const }
      }),
    })

    const accepting = acceptForLiveRecipients(request(`${TASK}.agent-2`), deps)
    await atProbe
    expect(held).toBe(true)
    releaseProbe()

    await expect(accepting).resolves.toMatchObject({
      ok: false,
      error: { code: 'ledger-rejected' },
    })
    expect(held).toBe(false)
  })
})

describe('managed-session to durable-ledger integration', () => {
  const roots: string[] = []

  afterEach(() => {
    resetSessionBackendOwnersForTests()
    for (const root of roots.splice(0)) {
      rmSync(`${join(root, 'server.lock')}.mark`, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses real session records, lifecycle leases, provider resolution, and ledger persistence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'live-recipient-integration-'))
    roots.push(root)
    const sessionsDir = join(root, 'sessions')
    const lockPath = join(root, 'server.lock')
    expect(acquireBackendSingleton(lockPath).acquired).toBe(true)
    const cfg = {
      sessions: { prefix: 'tinstar-' },
      cliTemplates: [],
      dirs: {
        root,
        sessions: sessionsDir,
        secrets: join(root, 'secrets.json'),
      },
    } as unknown as TinstarConfig
    createSession(sessionsDir, {
      name: 'codex-live',
      backend: 'tmux',
      adapter: 'codex',
      nats: { enabled: true, subscriptions: [TASK, `${TASK}.codex-live`] },
    })
    setState(sessionsDir, 'codex-live', 'running')
    const ledger = DeliveryLedger.open({
      dir: root,
      lockPath,
      createMessageId: () => 'msg-integrated',
      now: () => 1_000,
    })
    const registry = createDefaultProviderRegistry()

    const result = await acceptForManagedSessionRecipients(
      {
        sessionConfig: cfg,
        providerRegistry: registry,
        docStore: { getAllTombstones: () => [] },
      } as unknown as RouteContext,
      ledger,
      request(`${TASK}.codex-live`, 'req-integrated'),
      {
        observeProcess: async () => ({
          state: 'alive',
          incarnation: 'codex-live-process',
        }),
      },
    )

    expect(result).toMatchObject({
      ok: true,
      destinationKind: 'dm',
      acceptance: {
        accepted: true,
        message: { id: 'msg-integrated', requestId: 'req-integrated' },
        deliveries: [{
          recipient: {
            providerId: 'codex',
            sessionId: 'codex-live',
          },
        }],
      },
    })
    const persisted = JSON.parse(readFileSync(deliveryLedgerPaths(root).primary, 'utf8'))
    expect(persisted.messages).toHaveLength(1)
    expect(persisted.deliveries[0].recipient).toEqual({
      providerId: 'codex',
      sessionId: 'codex-live',
      incarnation: 'codex-live-process',
    })

    // A Tinstar restart rebuilds in-memory lifecycle owners, but the surviving
    // tmux process and the durable acceptance retain their identities.
    resetSessionBackendOwnersForTests()
    const reloadedLedger = DeliveryLedger.open({ dir: root, lockPath })
    const observeProcess = vi.fn(async () => {
      throw new Error('a durable retry must not re-resolve liveness')
    })
    const replayed = await acceptForManagedSessionRecipients(
      {
        sessionConfig: cfg,
        providerRegistry: registry,
        docStore: { getAllTombstones: () => [] },
      } as unknown as RouteContext,
      reloadedLedger,
      request(`${TASK}.codex-live`, 'req-integrated'),
      { observeProcess },
    )
    expect(replayed).toMatchObject({
      ok: true,
      acceptance: {
        accepted: true,
        replayed: true,
        deliveries: [{
          recipient: { incarnation: 'codex-live-process' },
        }],
      },
    })
    expect(observeProcess).not.toHaveBeenCalled()
  })

  it('validates malformed input even when session configuration is unavailable', async () => {
    const ledger = {
      accept: vi.fn(),
      replayAcceptance: vi.fn(),
    }

    await expect(acceptForManagedSessionRecipients(
      { sessionConfig: null } as unknown as RouteContext,
      ledger,
      undefined as unknown as LiveDeliveryRequest,
    )).resolves.toEqual({
      ok: false,
      error: { code: 'invalid-request', detail: 'request must be an object' },
    })
    expect(ledger.accept).not.toHaveBeenCalled()
    expect(ledger.replayAcceptance).not.toHaveBeenCalled()
  })

  it('allows dead-process reconciliation while preserving the probed process identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'live-recipient-generation-race-'))
    roots.push(root)
    const sessionsDir = join(root, 'sessions')
    const cfg = {
      sessions: { prefix: 'tinstar-' },
      cliTemplates: [],
      dirs: {
        root,
        sessions: sessionsDir,
        secrets: join(root, 'secrets.json'),
      },
    } as unknown as TinstarConfig
    createSession(sessionsDir, {
      name: 'generation-race',
      backend: 'tmux',
      adapter: 'claude',
      nats: { enabled: true, subscriptions: [TASK, `${TASK}.generation-race`] },
    })
    setState(sessionsDir, 'generation-race', 'running')
    let acceptEntered!: () => void
    let releaseAccept!: () => void
    const atAccept = new Promise<void>(resolve => { acceptEntered = resolve })
    const accepting = new Promise<void>(resolve => { releaseAccept = resolve })
    const accept = vi.fn(async () => {
      acceptEntered()
      await accepting
      return { accepted: false as const, reason: 'capacity-exceeded' as const }
    })

    const resultPromise = acceptForManagedSessionRecipients(
      {
        sessionConfig: cfg,
        providerRegistry: createDefaultProviderRegistry(),
        docStore: { getAllTombstones: () => [] },
      } as unknown as RouteContext,
      { accept, replayAcceptance: async () => null },
      request(`${TASK}.generation-race`, 'req-generation-race'),
      {
        observeProcess: async () => ({
          state: 'alive',
          incarnation: 'generation-race-process',
        }),
      },
    )

    await atAccept
    const generation = persistedSessionBackendGenerationForConfig(
      cfg,
      'generation-race',
    )
    expect(generation).not.toBeNull()
    expect(invalidatePersistedSessionBackendGenerationForConfig(
      cfg,
      'generation-race',
      generation!,
    )).toBe(true)
    releaseAccept()

    await expect(resultPromise).resolves.toEqual({
      ok: false,
      error: {
        code: 'ledger-rejected',
        destinationKind: 'dm',
        subject: `${TASK}.generation-race`,
        exclusions: [],
        rejection: { accepted: false, reason: 'capacity-exceeded' },
      },
    })
    expect(accept).toHaveBeenCalledOnce()
    expect(persistedSessionBackendGenerationForConfig(cfg, 'generation-race'))
      .not.toBe(generation)
  })
})

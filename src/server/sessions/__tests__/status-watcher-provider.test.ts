import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ProviderAdapterRegistry,
  type TerminalProviderAdapter,
} from '../../providers/lifecycle'
import { createSession, getSession, setState, type Session } from '../session'
import { StatusWatcher } from '../status-watcher'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'tinstar-provider-watcher-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('StatusWatcher provider transcripts', () => {
  it('bounds a non-settling provider discovery without starving healthy sessions', async () => {
    const healthyPath = join(scratch, 'bounded-healthy.jsonl')
    writeFileSync(healthyPath, '{}\n')
    const healthyReadStatus = vi.fn(() => ({ state: 'running' as const }))
    const capabilities: TerminalProviderAdapter['terminal']['capabilities'] = {
      nats: { state: 'unsupported', reason: 'not implemented' },
      telemetry: { state: 'unsupported', reason: 'not implemented' },
    }
    const stalledDiscover = vi.fn(() => new Promise<string | null>(() => undefined))
    const stalled: TerminalProviderAdapter = {
      provider: { id: 'stalled', label: 'Stalled CLI' },
      sessionLifecycle: 'terminal',
      terminal: {
        capabilities,
        defaultTelemetry: false,
        transcript: {
          discover: stalledDiscover,
          readStatus: () => ({ state: 'running' }),
          parseRecapEntries: () => [],
          resetOffset: vi.fn(),
        },
      },
    }
    const healthy: TerminalProviderAdapter = {
      provider: { id: 'bounded-healthy', label: 'Healthy CLI' },
      sessionLifecycle: 'terminal',
      terminal: {
        capabilities,
        defaultTelemetry: false,
        transcript: {
          discover: async () => healthyPath,
          readStatus: healthyReadStatus,
          parseRecapEntries: () => [],
          resetOffset: vi.fn(),
        },
      },
    }
    const sessionsDir = join(scratch, 'bounded-sessions')
    createSession(sessionsDir, {
      name: 'stalled-worker',
      backend: 'tmux',
      adapter: 'stalled',
      workspace: { path: scratch },
    })
    createSession(sessionsDir, {
      name: 'bounded-healthy-worker',
      backend: 'tmux',
      adapter: 'bounded-healthy',
      workspace: { path: scratch },
    })
    setState(sessionsDir, 'stalled-worker', 'running')
    setState(sessionsDir, 'bounded-healthy-worker', 'running')
    const watcher = new StatusWatcher({
      sessionsDir,
      providerRegistry: new ProviderAdapterRegistry([stalled, healthy]),
      providerPollTimeoutMs: 1_000,
      processProbeTimeoutMs: 20,
      onStatusChanged: vi.fn(),
    })

    const startedAt = Date.now()
    await (watcher as unknown as { tick(): Promise<void> }).tick()
    // The process fallback marks the synthetic session stopped. Make it live
    // again to exercise another watcher tick while discovery is still pending.
    setState(sessionsDir, 'stalled-worker', 'running')
    setState(sessionsDir, 'bounded-healthy-worker', 'running')
    await (watcher as unknown as { tick(): Promise<void> }).tick()

    expect(Date.now() - startedAt).toBeLessThan(600)
    expect(healthyReadStatus).toHaveBeenCalledWith(healthyPath)
    expect(stalledDiscover).toHaveBeenCalledTimes(1)
  })

  it('continues polling other sessions when a conversation project hook throws', async () => {
    const brokenPath = join(scratch, 'broken.jsonl')
    const healthyPath = join(scratch, 'healthy.jsonl')
    writeFileSync(brokenPath, '{}\n')
    writeFileSync(healthyPath, '{}\n')
    const brokenReadStatus = vi.fn(() => ({ state: 'running' as const }))
    const healthyReadStatus = vi.fn(() => ({ state: 'running' as const }))
    const terminalCapabilities: TerminalProviderAdapter['terminal']['capabilities'] = {
      nats: { state: 'unsupported', reason: 'not implemented' },
      telemetry: { state: 'unsupported', reason: 'not implemented' },
    }
    const broken: TerminalProviderAdapter = {
      provider: { id: 'broken', label: 'Broken CLI' },
      sessionLifecycle: 'terminal',
      terminal: {
        capabilities: terminalCapabilities,
        defaultTelemetry: false,
        transcript: {
          discover: async () => brokenPath,
          readStatus: brokenReadStatus,
          parseRecapEntries: () => [],
          resetOffset: vi.fn(),
          conversationProjectDir: () => {
            throw new Error('project hook exploded')
          },
        },
      },
    }
    const healthy: TerminalProviderAdapter = {
      provider: { id: 'healthy', label: 'Healthy CLI' },
      sessionLifecycle: 'terminal',
      terminal: {
        capabilities: terminalCapabilities,
        defaultTelemetry: false,
        transcript: {
          discover: async () => healthyPath,
          readStatus: healthyReadStatus,
          parseRecapEntries: () => [],
          resetOffset: vi.fn(),
        },
      },
    }
    const sessionsDir = join(scratch, 'hook-sessions')
    createSession(sessionsDir, {
      name: 'broken-worker',
      backend: 'tmux',
      adapter: 'broken',
      workspace: { path: scratch },
    })
    createSession(sessionsDir, {
      name: 'healthy-worker',
      backend: 'tmux',
      adapter: 'healthy',
      workspace: { path: scratch },
    })
    setState(sessionsDir, 'broken-worker', 'running')
    setState(sessionsDir, 'healthy-worker', 'running')
    const watcher = new StatusWatcher({
      sessionsDir,
      providerRegistry: new ProviderAdapterRegistry([broken, healthy]),
      onStatusChanged: vi.fn(),
    })

    await (watcher as unknown as { tick(): Promise<void> }).tick()

    expect(brokenReadStatus).toHaveBeenCalledWith(brokenPath)
    expect(healthyReadStatus).toHaveBeenCalledWith(healthyPath)
  })

  it('drives a fake third provider through its registered transcript adapter', async () => {
    const transcriptPath = join(scratch, 'forge.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    const discover = vi.fn(async () => transcriptPath)
    const readStatus = vi.fn(() => ({ state: 'idle' as const }))
    const parseRecapEntries = vi.fn(() => [{
      id: 'forge-recap',
      type: 'agent' as const,
      content: 'Forge completed the turn',
      timestamp: '2026-07-31T00:00:00.000Z',
    }])
    const forge: TerminalProviderAdapter = {
      provider: { id: 'forge', label: 'Forge CLI' },
      sessionLifecycle: 'terminal',
      terminal: {
        capabilities: {
          nats: { state: 'unsupported', reason: 'not implemented' },
          telemetry: { state: 'unsupported', reason: 'not implemented' },
        },
        defaultTelemetry: false,
        transcript: {
          discover,
          readStatus,
          parseRecapEntries,
          resetOffset: vi.fn(),
        },
      },
    }
    const registry = new ProviderAdapterRegistry([forge])
    const sessionsDir = join(scratch, 'sessions')
    createSession(sessionsDir, {
      name: 'forge-worker',
      backend: 'tmux',
      adapter: 'forge',
      workspace: { path: scratch },
    })
    setState(sessionsDir, 'forge-worker', 'running')
    const onStatusChanged = vi.fn()
    const onRecapEntries = vi.fn()
    const watcher = new StatusWatcher({
      sessionsDir,
      providerRegistry: registry,
      intervalMs: 10,
      onStatusChanged,
      onRecapEntries,
    })

    const session = getSession(sessionsDir, 'forge-worker')!
    const checkSession = (watcher as unknown as {
      checkSession(session: Session): Promise<void>
    }).checkSession.bind(watcher)
    // running -> idle is deliberately debounced across two observations.
    await checkSession(session)
    await checkSession(session)

    expect(discover).toHaveBeenCalled()
    expect(readStatus).toHaveBeenCalledWith(transcriptPath)
    expect(onStatusChanged).toHaveBeenCalledWith('forge-worker', 'idle', false)
    expect(onRecapEntries).toHaveBeenCalledWith(
      'forge-worker',
      expect.arrayContaining([expect.objectContaining({ id: 'forge-recap' })]),
    )
  })

  it('lets an adapter retain recap parsing on unchanged idle observations', async () => {
    const transcriptPath = join(scratch, 'boundary.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    const parseRecapEntries = vi.fn(() => [{
      id: 'between-polls',
      type: 'agent' as const,
      content: 'A complete turn began and ended between polls',
      timestamp: '2026-07-31T00:00:00.000Z',
    }])
    const boundary: TerminalProviderAdapter = {
      provider: { id: 'boundary', label: 'Boundary CLI' },
      sessionLifecycle: 'terminal',
      terminal: {
        capabilities: {
          nats: { state: 'unsupported', reason: 'not implemented' },
          telemetry: { state: 'unsupported', reason: 'not implemented' },
        },
        defaultTelemetry: false,
        transcript: {
          discover: async () => transcriptPath,
          readStatus: () => ({ state: 'idle' }),
          parseRecapEntries,
          parseRecapWhileIdle: true,
          resetOffset: vi.fn(),
        },
      },
    }
    const sessionsDir = join(scratch, 'boundary-sessions')
    createSession(sessionsDir, {
      name: 'boundary-worker',
      backend: 'tmux',
      adapter: 'boundary',
      workspace: { path: scratch },
    })
    setState(sessionsDir, 'boundary-worker', 'idle')
    const session = getSession(sessionsDir, 'boundary-worker')!
    const onRecapEntries = vi.fn()
    const watcher = new StatusWatcher({
      sessionsDir,
      providerRegistry: new ProviderAdapterRegistry([boundary]),
      onStatusChanged: vi.fn(),
      onRecapEntries,
    })

    await (watcher as unknown as {
      checkSession(session: Session): Promise<void>
    }).checkSession(session)

    expect(parseRecapEntries).toHaveBeenCalledWith('boundary-worker', transcriptPath)
    expect(onRecapEntries).toHaveBeenCalledWith(
      'boundary-worker',
      expect.arrayContaining([expect.objectContaining({ id: 'between-polls' })]),
    )
  })

  it('starts a fresh discovery generation after a stalled session stops and restarts', async () => {
    const transcriptPath = join(scratch, 'restart.jsonl')
    writeFileSync(transcriptPath, '{}\n')
    const discover = vi.fn()
      .mockImplementationOnce(() => new Promise<string | null>(() => undefined))
      .mockResolvedValueOnce(transcriptPath)
    const readStatus = vi.fn(() => ({ state: 'running' as const }))
    const provider: TerminalProviderAdapter = {
      provider: { id: 'restartable', label: 'Restartable CLI' },
      sessionLifecycle: 'terminal',
      terminal: {
        capabilities: {
          nats: { state: 'unsupported', reason: 'not implemented' },
          telemetry: { state: 'unsupported', reason: 'not implemented' },
        },
        defaultTelemetry: false,
        transcript: {
          discover,
          readStatus,
          parseRecapEntries: () => [],
          resetOffset: vi.fn(),
        },
      },
    }
    const sessionsDir = join(scratch, 'restart-sessions')
    createSession(sessionsDir, {
      name: 'restart-worker',
      backend: 'tmux',
      adapter: 'restartable',
      workspace: { path: scratch },
    })
    setState(sessionsDir, 'restart-worker', 'running')
    const watcher = new StatusWatcher({
      sessionsDir,
      providerRegistry: new ProviderAdapterRegistry([provider]),
      providerPollTimeoutMs: 20,
      onStatusChanged: vi.fn(),
    })
    const tick = (watcher as unknown as { tick(): Promise<void> }).tick.bind(watcher)
    const resetOffset = provider.terminal.transcript!.resetOffset as ReturnType<typeof vi.fn>

    await tick()
    setState(sessionsDir, 'restart-worker', 'stopped')
    await tick()
    setState(sessionsDir, 'restart-worker', 'running')
    await tick()

    expect(discover).toHaveBeenCalledTimes(2)
    expect(readStatus).toHaveBeenCalledWith(transcriptPath)
    expect(resetOffset).not.toHaveBeenCalled()
  })

  it('does not carry transcript caches across a reused session name', async () => {
    const firstPath = join(scratch, 'first-incarnation.jsonl')
    const secondPath = join(scratch, 'second-incarnation.jsonl')
    writeFileSync(firstPath, '{}\n')
    writeFileSync(secondPath, '{}\n')
    const discover = vi.fn()
      .mockResolvedValueOnce(firstPath)
      .mockResolvedValueOnce(secondPath)
    const readStatus = vi.fn(() => ({ state: 'running' as const }))
    const provider: TerminalProviderAdapter = {
      provider: { id: 'incarnated', label: 'Incarnated CLI' },
      sessionLifecycle: 'terminal',
      terminal: {
        capabilities: {
          nats: { state: 'unsupported', reason: 'not implemented' },
          telemetry: { state: 'unsupported', reason: 'not implemented' },
        },
        defaultTelemetry: false,
        transcript: {
          discover,
          readStatus,
          parseRecapEntries: () => [],
          resetOffset: vi.fn(),
        },
      },
    }
    const sessionsDir = join(scratch, 'incarnation-sessions')
    createSession(sessionsDir, {
      name: 'reused-name',
      backend: 'tmux',
      adapter: 'incarnated',
      workspace: { path: scratch },
    })
    const first = getSession(sessionsDir, 'reused-name')!
    const watcher = new StatusWatcher({
      sessionsDir,
      providerRegistry: new ProviderAdapterRegistry([provider]),
      onStatusChanged: vi.fn(),
    })
    const checkSession = (watcher as unknown as {
      checkSession(session: Session): Promise<void>
    }).checkSession.bind(watcher)

    await checkSession(first)
    await checkSession({
      ...first,
      created: new Date(Date.parse(first.created) + 1).toISOString(),
      conversation: { id: 'replacement-conversation' },
    })

    expect(discover).toHaveBeenCalledTimes(2)
    expect(readStatus).toHaveBeenNthCalledWith(1, firstPath)
    expect(readStatus).toHaveBeenNthCalledWith(2, secondPath)
  })

  it('drops all deleted-session caches even when provider cleanup throws', () => {
    const watcher = new StatusWatcher({
      sessionsDir: join(scratch, 'cleanup-sessions'),
      onStatusChanged: vi.fn(),
    })
    const transcript = {
      discover: async () => null,
      readStatus: () => null,
      parseRecapEntries: () => [],
      resetOffset: vi.fn(() => {
        throw new Error('cleanup exploded')
      }),
    }
    const internals = watcher as unknown as {
      pruneInactiveSessions(liveNames: Set<string>, existingNames: Set<string>): void
      transcriptAdapters: Map<string, typeof transcript>
      transcriptPaths: Map<string, string>
      transcriptDiscoveries: Map<string, Promise<string | null>>
      idleStreak: Map<string, number>
      processTreeOverride: Set<string>
    }
    internals.transcriptAdapters.set('deleted-worker', transcript)
    internals.transcriptPaths.set('deleted-worker', '/gone.jsonl')
    internals.transcriptDiscoveries.set(
      'deleted-worker',
      new Promise<string | null>(() => undefined),
    )
    internals.idleStreak.set('deleted-worker', 1)
    internals.processTreeOverride.add('deleted-worker')

    expect(() => internals.pruneInactiveSessions(new Set(), new Set())).not.toThrow()
    expect(internals.transcriptAdapters.has('deleted-worker')).toBe(false)
    expect(internals.transcriptPaths.has('deleted-worker')).toBe(false)
    expect(internals.transcriptDiscoveries.has('deleted-worker')).toBe(false)
    expect(internals.idleStreak.has('deleted-worker')).toBe(false)
    expect(internals.processTreeOverride.has('deleted-worker')).toBe(false)
  })
})

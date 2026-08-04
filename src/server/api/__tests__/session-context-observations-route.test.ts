import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderObservationRequestFor } from '../../../domain/provider-capabilities'
import type { ProviderAdapter } from '../../providers/contract'
import { createDefaultProviderRegistry } from '../../providers/lifecycle'
import { ProviderCurrentObservationStores } from '../../providers/observation-stores'
import { createSession, updateSession } from '../../sessions/session'
import { handleRequest, type RouteContext } from '../routes'

const OBSERVED_AT = '2026-08-01T12:00:00.000Z'

describe('legacy session context observation routes', () => {
  let root: string
  let server: ReturnType<typeof createServer>
  let baseUrl: string
  let ctx: RouteContext

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'session-context-route-'))
    const sessions = join(root, 'sessions')
    const registry = createDefaultProviderRegistry()
    const stores = new ProviderCurrentObservationStores()
    const session = createSession(sessions, {
      name: 'legacy-codex',
      backend: 'tmux',
      cliTemplate: 'codex-template',
      adapter: null,
    })
    stores.sessions.setContext({
      kind: 'session-context',
      providerId: 'codex',
      scope: { kind: 'session', sessionId: session.conversation.id! },
      source: { id: 'codex-rollout', label: 'Codex rollout' },
      freshness: {
        state: 'fresh',
        observedAt: OBSERVED_AT,
        checkedAt: OBSERVED_AT,
      },
      availability: {
        state: 'available',
        value: { usedPercent: 37, windowTokens: 200_000 },
      },
    })
    ctx = {
      sessionConfig: {
        sessions: { prefix: 'tinstar' },
        cliTemplates: [{
          id: 'codex-template',
          name: 'Codex',
          adapter: 'codex',
          startCmd: 'codex {prompt}',
          resumeCmd: 'codex resume {sessionId}',
        }],
        dirs: {
          root,
          sessions,
          secrets: join(root, 'secrets'),
        },
      },
      providerRegistry: registry,
      providerObservationStores: stores,
    } as unknown as RouteContext
    server = createServer((req, res) => {
      void handleRequest(ctx, req, res).then((handled) => {
        if (!handled) {
          res.statusCode = 404
          res.end()
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves an adapter-less legacy session through its non-Claude template', async () => {
    const response = await fetch(`${baseUrl}/api/sessions/legacy-codex/context-window`)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      data: {
        usedPercentage: 37,
        windowSize: 200_000,
        fetchedAt: OBSERVED_AT,
      },
    })
  })

  it('returns a stable conflict when a legacy session template was removed', async () => {
    updateSession(ctx.sessionConfig!.dirs.sessions, 'legacy-codex', {
      cliTemplate: 'removed-template',
    })

    const response = await fetch(`${baseUrl}/api/sessions/legacy-codex/context-window`)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'CONFLICT',
        message: 'CLI template "removed-template" is not configured',
      },
    })
  })

  it.each([
    {
      availability: {
        state: 'unsupported' as const,
        reason: 'Codex does not expose category details',
      },
      status: 409,
      code: 'CONFLICT',
    },
    {
      availability: {
        state: 'unavailable' as const,
        reason: 'temporarily-unavailable' as const,
        message: 'Codex transcript is temporarily unavailable',
      },
      status: 500,
      code: 'INTERNAL',
    },
  ])('maps $availability.state context availability without claiming false success', async ({
    availability,
    status,
    code,
  }) => {
    const registry = ctx.providerRegistry!
    registry.registerObservations({
      provider: registry.require('codex').provider,
      observe: {
        'context-breakdown': async (
          request: ProviderObservationRequestFor<'context-breakdown'>,
        ) => ({
          kind: request.kind,
          providerId: 'codex',
          scope: request.scope,
          source: null,
          freshness: {
            state: 'unknown',
            observedAt: null,
            checkedAt: OBSERVED_AT,
          },
          availability,
        }),
      },
    } as unknown as ProviderAdapter)

    const response = await fetch(`${baseUrl}/api/sessions/legacy-codex/context`)

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code },
    })
  })
})

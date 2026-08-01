import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderCurrentObservationsWire } from '../../../domain/provider-observation-wire'
import { CcQuotaService } from '../../cc-quota/service'
import { ProviderObservationIngestor } from '../../providers/observation-ingestor'
import { ProviderCurrentObservationStores } from '../../providers/observation-stores'
import { handleRequest, type RouteContext } from '../routes'

describe('GET /api/provider-observations', () => {
  let server: ReturnType<typeof createServer>
  let baseUrl: string

  beforeEach(async () => {
    const now = Date.parse('2026-08-01T12:00:01.000Z')
    const stores = new ProviderCurrentObservationStores({ now: () => now })
    const quota = new CcQuotaService({
      now: () => now,
      observationStores: stores,
    })
    quota.ingest({
      session_id: 'claude-session',
      rate_limits: {
        five_hour: { used_percentage: 40, resets_at: 1_785_588_800 },
      },
    })

    const ingestor = new ProviderObservationIngestor({
      stores,
      now: () => now,
    })
    ingestor.ingest({
      providerId: 'codex',
      sessionId: 'codex-session',
      accountRef: 'default',
      source: { id: 'rollout', label: 'Codex rollout events' },
      event: {
        id: 'codex-event-1',
        observedAt: '2026-08-01T12:00:00.000Z',
        replayed: true,
        sessionUsage: {
          model: 'gpt-5.4',
          cumulativeTokens: { total: 1_000 },
        },
      },
    })

    const ctx = {
      ccQuotaService: quota,
      providerObservationStores: stores,
    } as RouteContext
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
  })

  it('returns Codex rollout and Claude statusline data from the same store', async () => {
    const response = await fetch(`${baseUrl}/api/provider-observations`)
    const body = await response.json() as ProviderCurrentObservationsWire

    expect(response.status).toBe(200)
    expect(body.version).toBe(1)
    expect(body.sessionUsage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: 'codex',
        scope: { kind: 'session', sessionId: 'codex-session' },
        availability: expect.objectContaining({
          value: expect.objectContaining({ model: 'gpt-5.4' }),
        }),
      }),
    ]))
    expect(body.providerQuota).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: 'claude',
        scope: { kind: 'provider', accountRef: 'default' },
        availability: expect.objectContaining({ state: 'available' }),
      }),
    ]))
  })
})

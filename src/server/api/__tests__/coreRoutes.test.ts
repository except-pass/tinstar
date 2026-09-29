import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ProviderCurrentObservationsWire } from '../../../domain/provider-observation-wire'
import { CcQuotaService } from '../../cc-quota/service'
import { ProviderObservationIngestor } from '../../providers/observation-ingestor'
import { ProviderCurrentObservationStores } from '../../providers/observation-stores'
import { getReachCoordinator, resetReachCoordinatorForTests, unconfiguredReachProvider } from '../../reach'
import { handleCoreApi, type CoreApiDeps } from '../coreRoutes'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../originAllowlist'
import { SSEBroadcaster } from '../sse'
import { createTelemetryRoutes } from '../telemetry'

const NOW = Date.parse('2026-08-01T12:00:01.000Z')

let configRoot: string
let sse: SSEBroadcaster
let deps: CoreApiDeps
let baseUrl: string
let server: ReturnType<typeof createServer>

beforeEach(async () => {
  // POST /api/reach reaches the REAL coordinator; pin its root and an inert
  // provider so the suite never rewrites the operator's reach preference.
  configRoot = mkdtempSync(join(tmpdir(), 'tinstar-core-routes-'))
  process.env.TINSTAR_CONFIG_HOME = configRoot
  resetReachCoordinatorForTests()
  getReachCoordinator(unconfiguredReachProvider)

  const observations = new ProviderCurrentObservationStores({ now: () => NOW })
  sse = new SSEBroadcaster()
  deps = {
    quota: new CcQuotaService({ now: () => NOW, observationStores: observations }),
    observations,
    sse,
    telemetry: createTelemetryRoutes({
      sse,
      providerQuery: null,
      getState: () => 'disabled',
      getProgress: () => undefined,
      getLastError: () => null,
      restart: async () => {},
      getDefaultUserEmail: () => '',
    }),
    boundPort: () => 5273,
  }
  server = createServer((req, res) => {
    void handleCoreApi(deps, req, res).then(handled => { if (!handled) { res.statusCode = 404; res.end() } })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  sse.destroy()
  server.closeAllConnections()
  await new Promise<void>(r => server.close(() => r()))
  resetOriginAllowlistForTests()
  resetReachCoordinatorForTests()
  rmSync(configRoot, { recursive: true, force: true })
})

const JSON_CT = { 'Content-Type': 'application/json' }

async function postReach(body: string, headers: Record<string, string>) {
  const resp = await fetch(`${baseUrl}/api/reach`, { method: 'POST', headers, body })
  const parsed = await resp.json().catch(() => null) as { error?: { message?: string } } | null
  return { status: resp.status, body: parsed }
}

const statusline = {
  session_id: 'abc',
  rate_limits: {
    five_hour: { used_percentage: 33, resets_at: 1776981600 },
    seven_day: { used_percentage: 77, resets_at: 1777168800 },
  },
}

describe('POST /api/reach — who may flip remote exposure', () => {
  it('refuses a body that is not {"enabled": boolean}', async () => {
    expect((await postReach('{"enabled":"yes"}', JSON_CT)).status).toBe(400)
    expect((await postReach('not json at all', JSON_CT)).status).toBe(400)
  })

  it('refuses a cross-origin request from outside the allowlist', async () => {
    seedOriginAllowlist(5273)
    const { status, body } = await postReach('{"enabled":true}', { ...JSON_CT, Origin: 'https://evil.example.com' })
    expect(status).toBe(403)
    expect(body?.error?.message ?? '').toMatch(/origin/i)
  })

  it('refuses a simple-request content type, which is what dodges the preflight', async () => {
    seedOriginAllowlist(5273)
    expect((await postReach('{"enabled":true}', { 'Content-Type': 'text/plain' })).status).toBe(415)
  })

  it('admits a same-origin browser request', async () => {
    seedOriginAllowlist(5273)
    expect((await postReach('{"enabled":false}', { ...JSON_CT, Origin: 'http://localhost:5273' })).status).toBe(200)
  })

  it('admits a request with no Origin at all, which is how the CLI calls it', async () => {
    seedOriginAllowlist(5273)
    expect((await postReach('{"enabled":false}', JSON_CT)).status).toBe(200)
  })

  it('writes the preference it changes into this test\'s own root', async () => {
    seedOriginAllowlist(5273)
    expect((await postReach('{"enabled":false}', JSON_CT)).status).toBe(200)
    expect(existsSync(join(configRoot, 'reach', 'preference.json'))).toBe(true)
    expect(configRoot.startsWith(tmpdir())).toBe(true)
  })
})

describe('cc-quota routes', () => {
  it('GET returns the empty snapshot before anything is ingested', async () => {
    const resp = await fetch(`${baseUrl}/api/cc-quota`)
    expect(resp.status).toBe(200)
    expect(await resp.json()).toMatchObject({ data: null, error: null })
  })

  it('POST ingests a statusline payload and GET returns it', async () => {
    const post = await fetch(`${baseUrl}/api/cc-quota/ingest`, { method: 'POST', headers: JSON_CT, body: JSON.stringify(statusline) })
    expect(post.status).toBe(200)
    const posted = await post.json() as { data: { five_hour: { utilization: number }; seven_day: { utilization: number } }; error: null }
    expect(posted.data.five_hour.utilization).toBe(33)
    expect(posted.data.seven_day.utilization).toBe(77)
    expect(posted.error).toBeNull()
    const got = await (await fetch(`${baseUrl}/api/cc-quota`)).json() as typeof posted
    expect(got.data.five_hour.utilization).toBe(33)
  })

  it('POST returns 400 on malformed JSON', async () => {
    const resp = await fetch(`${baseUrl}/api/cc-quota/ingest`, { method: 'POST', headers: JSON_CT, body: 'not json' })
    expect(resp.status).toBe(400)
    expect(await resp.json()).toEqual({ ok: false, error: { code: 'BAD_REQUEST', message: 'malformed_json' } })
  })
})

describe('GET /api/provider-observations', () => {
  it('returns Codex OTel and Claude statusline data from the same store', async () => {
    deps.quota.ingest({ session_id: 'claude-session', rate_limits: { five_hour: { used_percentage: 40, resets_at: 1_785_588_800 } } })
    new ProviderObservationIngestor({ stores: deps.observations, now: () => NOW }).ingest({
      providerId: 'codex',
      sessionId: 'codex-session',
      accountRef: 'default',
      source: { id: 'codex-otel', label: 'Codex OpenTelemetry' },
      event: {
        id: 'codex-event-1',
        observedAt: '2026-08-01T12:00:00.000Z',
        replayed: true,
        sessionUsage: { model: 'gpt-5.4', cumulativeTokens: { total: 1_000 } },
      },
    })

    const resp = await fetch(`${baseUrl}/api/provider-observations`)
    const body = await resp.json() as ProviderCurrentObservationsWire

    expect(resp.status).toBe(200)
    expect(body.version).toBe(1)
    expect(body.sessionUsage).toEqual(expect.arrayContaining([
      expect.objectContaining({
        providerId: 'codex',
        scope: { kind: 'session', sessionId: 'codex-session' },
        availability: expect.objectContaining({ value: expect.objectContaining({ model: 'gpt-5.4' }) }),
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

describe('GET /api/events', () => {
  it('streams named events from the broadcaster without a fake snapshot', async () => {
    const controller = new AbortController()
    const resp = await fetch(`${baseUrl}/api/events`, { signal: controller.signal })
    expect(resp.status).toBe(200)
    expect(resp.headers.get('content-type')).toBe('text/event-stream')
    sse.broadcastEvent('telemetry:hud', { state: 'ready' })
    const reader = resp.body!.getReader()
    const { value } = await reader.read()
    expect(new TextDecoder().decode(value)).toBe('event: telemetry:hud\ndata: {"state":"ready"}\n\n')
    controller.abort()
  })
})

describe('telemetry routes', () => {
  it('are served through the core API', async () => {
    const resp = await fetch(`${baseUrl}/api/telemetry/hud`)
    expect(resp.status).toBe(200)
    expect(await resp.json()).toMatchObject({ state: 'disabled', cost: { total: null } })
    deps.telemetry.stopPolling()
  })
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchCcQuota } from '../fetcher'
import { CcQuotaFetchError } from '../types'

function makeFakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'ccq-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  return home
}

function writeCreds(home: string, token: string) {
  writeFileSync(
    join(home, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: token } })
  )
}

describe('fetchCcQuota', () => {
  let home: string
  let origHome: string | undefined

  beforeEach(() => {
    home = makeFakeHome()
    origHome = process.env.HOME
    process.env.HOME = home
    vi.restoreAllMocks()
  })

  afterEach(() => {
    process.env.HOME = origHome
    rmSync(home, { recursive: true, force: true })
  })

  it('returns parsed RawUsage on 200', async () => {
    writeCreds(home, 'tok-abc')
    const body = {
      five_hour: { utilization: 67, resets_at: '2026-04-23T15:49:59Z' },
      seven_day: { utilization: 89, resets_at: '2026-04-23T20:00:00Z' },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: 2, resets_at: '2026-04-23T21:00:00Z' },
      extra_usage: { is_enabled: true, used_credits: 8148, currency: 'USD' },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })))
    const out = await fetchCcQuota()
    expect(out.five_hour?.utilization).toBe(67)
    expect(out.seven_day_opus).toBeNull()
  })

  it('throws no_creds when credentials file is missing', async () => {
    await expect(fetchCcQuota()).rejects.toBeInstanceOf(CcQuotaFetchError)
    await expect(fetchCcQuota()).rejects.toMatchObject({ info: { code: 'no_creds' } })
  })

  it('throws no_creds when accessToken field is absent', async () => {
    writeFileSync(join(home, '.claude', '.credentials.json'), JSON.stringify({}))
    await expect(fetchCcQuota()).rejects.toMatchObject({ info: { code: 'no_creds' } })
  })

  it('throws expired_token on 401', async () => {
    writeCreds(home, 'stale')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })))
    await expect(fetchCcQuota()).rejects.toMatchObject({ info: { code: 'expired_token' } })
  })

  it('throws http_5xx on 503', async () => {
    writeCreds(home, 'tok')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })))
    await expect(fetchCcQuota()).rejects.toMatchObject({ info: { code: 'http_5xx' } })
  })

  it('throws network on fetch rejection', async () => {
    writeCreds(home, 'tok')
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(fetchCcQuota()).rejects.toMatchObject({ info: { code: 'network' } })
  })
})

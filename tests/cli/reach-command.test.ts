// `tinstar reach` has shipped one regression already — a grant installer that
// returned falsy on success, so `reach on` refused every time including when it
// worked. It had no test then. These are that test.
//
// The shape under scrutiny is the split agreed with the operator: the SERVER
// owns whether the mapping actually came down, and the CLI owns the local
// cleanup it can always perform. The grant is the hinge — removing it while the
// mapping is still live takes away the only means of finishing the job.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let root: string
const grant = { installed: 0, removed: 0 }
let response: { ok: boolean; body: unknown } | Error

vi.mock('../../bin/apiBase.js', () => ({
  getApiBase: async () => 'http://127.0.0.1:5273',
}))

vi.mock('../../bin/tinstar/commands/service.js', () => ({
  installReachGrant: () => { grant.installed += 1; return true },
  removeReachGrant: () => { grant.removed += 1; return true },
}))

vi.mock('../../bin/configRoot.js', () => ({
  getConfigRoot: () => root,
}))

function preference(): { enabled?: boolean } | null {
  const file = join(root, 'reach', 'preference.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf-8'))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tinstar-reach-cli-'))
  mkdirSync(join(root, 'reach'), { recursive: true })
  writeFileSync(
    join(root, 'reach', 'preference.json'),
    JSON.stringify({ version: 1, enabled: true, provider: 'tailscale' }),
  )
  grant.installed = 0
  grant.removed = 0
  vi.stubGlobal('fetch', async () => {
    if (response instanceof Error) throw response
    // Captured after the guard: `response` is a mutable binding, so the narrowing
    // does not survive into the `json` closure below.
    const answer = response
    return {
      ok: answer.ok,
      status: answer.ok ? 200 : 400,
      json: async () => answer.body,
    } as unknown as Response
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`)
  }) as never)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function reach(sub: string): Promise<string | null> {
  const { run } = await import('../../bin/tinstar/commands/reach.js')
  try {
    await run([sub])
    return null
  } catch (err) {
    return (err as Error).message
  }
}

describe('tinstar reach off', () => {
  it('clears the opt-in and drops the grant when the mapping confirmed down', async () => {
    response = { ok: true, body: { data: { state: 'off' } } }
    expect(await reach('off')).toBeNull()
    expect(preference()?.enabled).toBe(false)
    expect(grant.removed).toBe(1)
  })

  it('KEEPS the grant when the server reports stranded', async () => {
    // The mapping is still live. Removing the grant here is precisely what
    // stripped the ability to retry, so it must survive a stranded report.
    response = {
      ok: true,
      body: { data: { state: 'stranded', url: 'https://h.ts.net', detail: 'tailscaled down' } },
    }
    expect(await reach('off')).toBe('exit:1')
    expect(grant.removed).toBe(0)
    expect(preference()?.enabled).toBe(false)
  })

  it('still clears the opt-in when the server is unreachable, and keeps the grant', async () => {
    // The case the operator cares about: server down, and they want to be sure
    // reach is not coming back. The preference is a local file, so the CLI can
    // always honour that much even with nothing to talk to.
    response = new Error('ECONNREFUSED')
    expect(await reach('off')).toBe('exit:1')
    expect(preference()?.enabled).toBe(false)
    expect(grant.removed).toBe(0)
  })
})

describe('tinstar reach on', () => {
  it('installs the grant before asking the server to establish', async () => {
    response = { ok: true, body: { data: { state: 'active', url: 'https://h.ts.net' } } }
    expect(await reach('on')).toBeNull()
    expect(grant.installed).toBe(1)
  })

  it('exits non-zero when the server refuses', async () => {
    response = { ok: false, body: { error: { message: 'tailscale not installed' } } }
    expect(await reach('on')).toBe('exit:1')
  })
})

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ExecFileException } from 'node:child_process'
import {
  QUOTA_AXI_ARGS,
  QUOTA_AXI_COMMAND,
  executeQuotaAxi,
  interpretQuotaAxi,
  parseQuotaAxiSnapshot,
} from '../axi'
import { registerQuotaRoutes, type QuotaRequestHandler } from '../register'
import {
  CODEX_QUOTA_UNSUPPORTED_REASON,
  GROK_QUOTA_UNSUPPORTED_REASON,
} from '../reasons'

const NOW = '2030-01-01T00:00:00.000Z'
const RESET = '2030-01-07T07:12:00.000Z'

function knownScope(scope: string, percent: number, windowId = 'weekly') {
  return {
    scope,
    status: 'known',
    effectivePercentRemaining: percent,
    boundedBy: [windowId],
    limitingWindowIds: [windowId],
    runway: { status: 'through_reset' },
  }
}

function schema6() {
  return {
    fixture: true,
    generatedAt: NOW,
    schemaVersion: 6,
    providers: [
      {
        provider: 'codex',
        accountKey: 'openai-codex',
        state: { status: 'fresh', stale: false },
        windows: [{ id: 'weekly', resetsAt: RESET, percentRemaining: 40 }],
        quotaSemantics: {
          status: 'known',
          effectiveAvailability: [
            knownScope('all_models', 40),
            knownScope('model:spark', 12, 'spark'),
          ],
        },
      },
      {
        provider: 'codex',
        accountKey: 'openai-codex-work',
        state: { status: 'fresh', stale: false },
        windows: [{ id: 'weekly', resetsAt: RESET }],
        quotaSemantics: {
          status: 'known',
          effectiveAvailability: [knownScope('all_models', 25)],
        },
      },
    ],
  }
}

function makeRes() {
  const captured = { status: 0, body: '', wrote: false }
  const state = { headersSent: false, writableEnded: false }
  const res = {
    get headersSent() { return state.headersSent },
    get writableEnded() { return state.writableEnded },
    writeHead(status: number) {
      captured.status = status
      captured.wrote = true
      state.headersSent = true
      return res
    },
    end(chunk?: string) {
      captured.body += chunk ?? ''
      state.writableEnded = true
      return res
    },
  } as unknown as ServerResponse
  return { captured, res }
}

function req(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage
}

async function listen(handle: QuotaRequestHandler) {
  const server = createServer((request, response) => {
    void handle(request, response).then((handled) => {
      if (!handled && !response.writableEnded) {
        response.writeHead(404)
        response.end()
      }
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve())
    }),
  }
}

describe('quota-axi snapshot', () => {
  it('keeps schema 6 accounts separate, in their own percent, with the limiting window reset', () => {
    const snapshot = parseQuotaAxiSnapshot(schema6())
    expect(snapshot.state).toBe('available')
    if (snapshot.state !== 'available') return
    expect(snapshot.fixture).toBe(true)
    expect(snapshot.schemaVersion).toBe(6)
    expect(snapshot.accounts).toHaveLength(2)
    expect(snapshot.accounts.map((account) => account.accountKey)).toEqual([
      'openai-codex',
      'openai-codex-work',
    ])
    expect(snapshot.accounts[0]?.scopes.map((scope) => scope.percentRemaining)).toEqual([40, 12])
    expect(snapshot.accounts[0]?.scopes[0]).toMatchObject({
      unit: 'percent-remaining',
      resetsAt: RESET,
      runway: 'through_reset',
    })
    expect(snapshot.accounts[1]?.scopes[0]?.percentRemaining).toBe(25)
    const encoded = JSON.stringify(snapshot)
    expect(encoded).not.toContain('65')
    expect(encoded).not.toContain('"total"')
    expect(encoded).not.toContain('"sum"')
  })

  it('treats schema 5 as one row per provider and does not invent an account key', () => {
    const snapshot = parseQuotaAxiSnapshot({
      schemaVersion: 5,
      fixture: true,
      providers: [
        {
          provider: 'claude',
          accountKey: 'should-be-ignored',
          quotaSemantics: {
            status: 'known',
            effectiveAvailability: [knownScope('all_models', 80)],
          },
        },
        {
          provider: 'grok',
          quotaSemantics: {
            status: 'unknown',
            effectiveAvailability: [],
          },
        },
      ],
    })
    expect(snapshot.state).toBe('available')
    if (snapshot.state !== 'available') return
    expect(snapshot.accounts.map((account) => [account.provider, account.accountKey])).toEqual([
      ['claude', null],
      ['grok', null],
    ])
    expect(snapshot.accounts[1]?.scopes).toEqual([])
  })

  it('renders any other schema, a bad row, a missing binary, or a non-zero exit as unavailable', () => {
    const other = parseQuotaAxiSnapshot({
      schemaVersion: 4,
      providers: [{ provider: 'codex', quotaSemantics: { status: 'known', effectiveAvailability: [knownScope('all_models', 73)] } }],
    })
    expect(other).toMatchObject({ state: 'unavailable', reason: 'schema' })
    expect(JSON.stringify(other)).not.toContain('73')

    expect(parseQuotaAxiSnapshot({
      schemaVersion: 6,
      providers: [
        { provider: 'codex', accountKey: 'same', quotaSemantics: { status: 'unknown', effectiveAvailability: [] } },
        { provider: 'codex', accountKey: 'same', quotaSemantics: { status: 'unknown', effectiveAvailability: [] } },
      ],
    }).state).toBe('unavailable')

    expect(parseQuotaAxiSnapshot({
      schemaVersion: 5,
      providers: [{
        provider: 'codex',
        quotaSemantics: {
          status: 'unknown',
          effectiveAvailability: [{
            scope: 'all_models',
            status: 'unknown',
            effectivePercentRemaining: 40,
          }],
        },
      }],
    }).state).toBe('unavailable')

    expect(interpretQuotaAxi({ missing: true, exitCode: null, stdout: '' })).toMatchObject({
      state: 'unavailable',
      reason: 'missing',
    })
    expect(interpretQuotaAxi({
      missing: false,
      exitCode: 2,
      stdout: JSON.stringify(schema6()),
    })).toMatchObject({ state: 'unavailable', reason: 'exit' })
    expect(JSON.stringify(interpretQuotaAxi({
      missing: false,
      exitCode: 2,
      stdout: JSON.stringify(schema6()),
    }))).not.toContain('openai-codex')
    expect(interpretQuotaAxi({ missing: false, exitCode: 0, stdout: '{oops' })).toMatchObject({
      state: 'unavailable',
      reason: 'malformed',
    })
  })

  it('runs only the fixed argv and does not open a shell', async () => {
    const calls: Array<{ file: string; args: readonly string[]; shell: unknown }> = []
    const result = await executeQuotaAxi((file, args, options, callback) => {
      calls.push({ file, args, shell: options.shell })
      callback(null, JSON.stringify({ schemaVersion: 5, providers: [], fixture: true }), '')
    })
    expect(calls).toEqual([{
      file: QUOTA_AXI_COMMAND,
      args: [...QUOTA_AXI_ARGS],
      shell: false,
    }])
    expect(QUOTA_AXI_COMMAND).toBe('quota-axi')
    expect([...QUOTA_AXI_ARGS]).toEqual(['--json'])
    expect(result).toMatchObject({ missing: false, exitCode: 0 })

    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' }) as ExecFileException
    const enoent = await executeQuotaAxi((_file, _args, _options, callback) => {
      callback(missing, '', '')
    })
    expect(enoent.missing).toBe(true)

    const failed = Object.assign(new Error('exit'), { code: 1 }) as ExecFileException
    const nonzero = await executeQuotaAxi((_file, _args, _options, callback) => {
      callback(failed, JSON.stringify(schema6()), '')
    })
    expect(nonzero).toMatchObject({ missing: false, exitCode: 1, stdout: '' })
  })
})

describe('registerQuotaRoutes', () => {
  it('serves schema 6 on a throwaway listener and labels the fixture', async () => {
    const runQuotaAxi = vi.fn(async () => ({
      missing: false,
      exitCode: 0,
      stdout: JSON.stringify(schema6()),
    }))
    const handle = registerQuotaRoutes({ runQuotaAxi })
    const server = await listen(handle)
    try {
      const response = await fetch(`${server.url}/api/v6/quota?command=fm-quota-choose.sh`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      const body = await response.json() as {
        ok: boolean
        data: {
          fixture: boolean
          codex: { state: string; reason: string }
          grok: { state: string; reason: string }
          axi: { accounts: Array<{ accountKey: string; scopes: Array<{ percentRemaining: number }> }> }
        }
      }
      expect(body.ok).toBe(true)
      expect(body.data.fixture).toBe(true)
      expect(body.data.codex).toEqual({
        state: 'unsupported',
        reason: CODEX_QUOTA_UNSUPPORTED_REASON,
      })
      expect(body.data.grok).toEqual({
        state: 'unsupported',
        reason: GROK_QUOTA_UNSUPPORTED_REASON,
      })
      expect(body.data.axi.accounts.map((account) => account.accountKey)).toEqual([
        'openai-codex',
        'openai-codex-work',
      ])
      expect(runQuotaAxi).toHaveBeenCalledTimes(1)
      expect(runQuotaAxi.mock.calls[0]).toEqual([])
      expect(JSON.stringify(body)).not.toContain('65')
    } finally {
      await server.close()
    }
  })

  it('rejects a non-GET and ignores every other path without running a command', async () => {
    const runQuotaAxi = vi.fn()
    const handle = registerQuotaRoutes({ runQuotaAxi })
    const posted = makeRes()
    expect(await handle(req('POST', '/api/v6/quota'), posted.res)).toBe(true)
    expect(posted.captured.status).toBe(400)
    expect(runQuotaAxi).not.toHaveBeenCalled()

    const other = makeRes()
    expect(await handle(req('GET', '/api/cc-quota'), other.res)).toBe(false)
    expect(other.captured.wrote).toBe(false)
    expect(runQuotaAxi).not.toHaveBeenCalled()
  })

  it('does not name a quota chooser or a shell in this module', () => {
    const roots = ['src/v6/quota', 'src/server/v6/quota']
    const files = roots.flatMap((root) => walk(root)).filter((file) => !file.includes('__tests__'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toContain('fm-quota-choose')
      expect(text, file).not.toContain('fm-spawn')
      expect(text, file).not.toContain('fm-send')
      expect(text, file).not.toContain('fm-control')
      expect(text, file).not.toContain('shell: true')
      expect(text, file).not.toContain('exec(')
    }
    const client = files.filter((file) => file.startsWith('src/v6/quota/') && !file.includes('__tests__'))
    const clientText = client.map((file) => readFileSync(file, 'utf8')).join('\n')
    expect(clientText).toContain("apiFetch('/api/cc-quota')")
    expect(clientText).toContain("apiFetch('/api/v6/quota')")
    expect(clientText).not.toContain('child_process')
    const reasons = readFileSync('src/v6/quota/reasons.ts', 'utf8')
    expect(reasons).toContain(`'${CODEX_QUOTA_UNSUPPORTED_REASON}'`)
    expect(reasons).toContain(`'${GROK_QUOTA_UNSUPPORTED_REASON}'`)
  })
})

function walk(dir: string): string[] {
  const found: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...walk(path))
    else if (/\.(ts|tsx|css)$/.test(name)) found.push(path)
  }
  return found
}

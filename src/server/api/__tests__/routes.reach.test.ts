// POST /api/reach is the one unauthenticated route that changes what the host is
// reachable FROM. Everything else here reads or writes local state; this one asks
// an external provider to publish a URL. So it carries a gate the read path does
// not, and these tests are that gate's only proof.
import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { handleRequest, type RouteContext } from '../routes'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../originAllowlist'

afterEach(() => {
  resetOriginAllowlistForTests()
})

async function post(
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: { error?: { message?: string } } | null }> {
  const ctx = { boundPort: 5273 } as unknown as RouteContext
  const server = createServer((req, res) => {
    handleRequest(ctx, req, res).then(h => { if (!h) { res.statusCode = 404; res.end() } })
  })
  await new Promise<void>(r => server.listen(0, r))
  const port = (server.address() as AddressInfo).port
  const resp = await fetch(`http://127.0.0.1:${port}/api/reach`, { method: 'POST', headers, body })
  const parsed = await resp.json().catch(() => null)
  await new Promise<void>(r => server.close(() => r()))
  return { status: resp.status, body: parsed }
}

const JSON_CT = { 'Content-Type': 'application/json' }

describe('POST /api/reach — who may flip remote exposure', () => {
  it('refuses a body that is not {"enabled": boolean}', async () => {
    expect((await post('{"enabled":"yes"}', JSON_CT)).status).toBe(400)
    expect((await post('not json at all', JSON_CT)).status).toBe(400)
  })

  it('refuses a cross-origin request from outside the allowlist', async () => {
    // A browser on any page can POST cross-origin without a preflight if the
    // request is "simple". CORS would then hide the RESPONSE from the attacker
    // while the side effect — publishing this host on the tailnet — has already
    // happened. Reading the answer was never the point.
    seedOriginAllowlist(5273)
    const { status, body } = await post(
      '{"enabled":true}',
      { ...JSON_CT, Origin: 'https://evil.example.com' },
    )
    expect(status).toBe(403)
    expect(body?.error?.message ?? '').toMatch(/origin/i)
  })

  it('refuses a simple-request content type, which is what dodges the preflight', async () => {
    // text/plain is one of the three content types that never trigger a
    // preflight. Requiring JSON is what forces the browser to ask permission
    // first, and the allowlist is what makes it get "no".
    seedOriginAllowlist(5273)
    const { status } = await post('{"enabled":true}', { 'Content-Type': 'text/plain' })
    expect(status).toBe(415)
  })

  it('admits a same-origin browser request', async () => {
    seedOriginAllowlist(5273)
    const { status } = await post(
      '{"enabled":false}',
      { ...JSON_CT, Origin: 'http://localhost:5273' },
    )
    expect(status).toBe(200)
  })

  it('admits a request with no Origin at all, which is how the CLI calls it', async () => {
    // `tinstar reach on` is not a browser and sends no Origin. Refusing an
    // absent Origin would break the only supported way to turn reach on.
    seedOriginAllowlist(5273)
    expect((await post('{"enabled":false}', JSON_CT)).status).toBe(200)
  })
})

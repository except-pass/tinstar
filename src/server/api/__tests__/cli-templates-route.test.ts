import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { handleRequest, type RouteContext } from '../routes'
import { loadConfig } from '../../sessions/config'
import type { CliTemplate } from '../../sessions/config'

// One ctx + server reused across requests, so a write that reassigns
// ctx.sessionConfig is visible to the next request — the exact shape of the
// "saves in the settings modal don't stick" bug.
let root: string
let ctx: RouteContext
let base: string
let server: ReturnType<typeof createServer>

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'cli-tmpl-'))
  // Real loadConfig → deep-frozen config that includes DEFAULT_CLI_TEMPLATES.
  ctx = { sessionConfig: loadConfig({ _rootDir: root }) } as unknown as RouteContext
  server = createServer((req, res) => {
    handleRequest(ctx, req, res).then(h => { if (!h) { res.statusCode = 404; res.end() } })
  })
  await new Promise<void>(r => server.listen(0, r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>(r => server.close(() => r()))
  rmSync(root, { recursive: true, force: true })
})

async function getTemplates(): Promise<CliTemplate[]> {
  const r = await fetch(`${base}/api/cli-templates`)
  return (await r.json() as { data: CliTemplate[] }).data
}

describe('PUT /api/cli-templates/:name — save reflects immediately', () => {
  it('an edited default template is visible on the next GET (no restart)', async () => {
    // Sanity: the default codex template is present and unedited.
    const before = await getTemplates()
    const codexBefore = before.find(t => t.name === 'Codex (full auto)')
    expect(codexBefore).toBeTruthy()

    const edited = { ...codexBefore!, startCmd: 'codex --sandbox workspace-write -- {prompt}', resumeCmd: 'codex resume --last --sandbox workspace-write' }
    const put = await fetch(`${base}/api/cli-templates/${encodeURIComponent('Codex (full auto)')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(edited),
    })
    expect(put.status).toBe(200)

    // The bug: GET returned the boot-time snapshot, so the edit "reverted" in the
    // modal. It must now reflect the saved command.
    const after = await getTemplates()
    const codexAfter = after.find(t => t.name === 'Codex (full auto)')
    expect(codexAfter?.startCmd).toBe('codex --sandbox workspace-write -- {prompt}')
    expect(codexAfter?.resumeCmd).toBe('codex resume --last --sandbox workspace-write')

    // And it's an override persisted to the user config file.
    const file = JSON.parse(readFileSync(join(root, 'config.json'), 'utf-8'))
    expect(file.cliTemplates.some((t: CliTemplate) => t.name === 'Codex (full auto)' && t.startCmd === 'codex --sandbox workspace-write -- {prompt}')).toBe(true)
    // The refreshed in-memory config a launch would read is updated too.
    expect((ctx.sessionConfig!.cliTemplates.find(t => t.name === 'Codex (full auto)'))?.startCmd)
      .toBe('codex --sandbox workspace-write -- {prompt}')
  })

  it('a newly-added template survives to the next GET', async () => {
    const post = await fetch(`${base}/api/cli-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'My Agent', adapter: 'generic', startCmd: 'mytool -- {prompt}', resumeCmd: 'mytool resume' }),
    })
    expect(post.status).toBe(200)
    const after = await getTemplates()
    expect(after.some(t => t.name === 'My Agent')).toBe(true)
  })

  it('deleting a user override is reflected on the next GET', async () => {
    // Add, then delete; the deletion must stick without a restart.
    await fetch(`${base}/api/cli-templates`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Temp', adapter: 'generic', startCmd: 'x -- {prompt}', resumeCmd: 'x' }),
    })
    expect((await getTemplates()).some(t => t.name === 'Temp')).toBe(true)
    const del = await fetch(`${base}/api/cli-templates/${encodeURIComponent('Temp')}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect((await getTemplates()).some(t => t.name === 'Temp')).toBe(false)
  })
})

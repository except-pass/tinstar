import { createServer, Server } from 'node:http'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleWiredHttp, wireV6Modules } from '../../wire'

describe('wireV6Modules', () => {
  const savedEmit = Server.prototype.emit
  let base = ''
  let server: Server

  beforeAll(async () => {
    process.env.TINSTAR_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'v6-wire-'))
    server = createServer((req, res) => {
      void handleWiredHttp(req, res).then(handled => {
        if (!handled && !res.headersSent) {
          res.writeHead(404)
          res.end('shell')
        }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    expect(address.port).not.toBe(5280)
    expect(address.port).not.toBe(5281)
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    Server.prototype.emit = savedEmit
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('calls each module registrar and serves its route', async () => {
    const source = readFileSync(join(process.cwd(), 'src/server/v6/wire.ts'), 'utf8')
    for (const name of [
      'registerNeedsYouRoutes',
      'registerPortfolioRoutes',
      'registerObjectiveRoutes',
      'registerQuotaRoutes',
      'registerThreadRoutes',
      'registerAccountRoutes',
    ]) {
      expect(source).toContain(name)
    }

    const needsYou = await fetch(`${base}/api/v6/needsyou`)
    expect(needsYou.status).toBe(200)
    const portfolio = await fetch(`${base}/api/v6/portfolio`)
    expect(portfolio.status).toBe(200)
    const objectives = await fetch(`${base}/api/v6/objectives`)
    expect(objectives.status).toBe(200)
    const threads = await fetch(`${base}/api/v6/threads`)
    expect(threads.status).toBe(400)
    const quota = await fetch(`${base}/api/v6/quota`)
    expect(quota.status).toBe(200)
    const board = await fetch(`${base}/api/v6/account/board`)
    expect(board.status).toBe(200)

    const command = await fetch(`${base}/api/v6/portfolio/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'echo hi' }),
    })
    expect(command.status).toBe(403)
    const tmux = await fetch(`${base}/api/v6/account/schedule/sample`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-1', plannedMs: 1000, elapsedMs: 1, target: 'firstmate:0.0' }),
    })
    expect(tmux.status).toBe(403)
  })

  it('answers module paths on the process server and leaves other paths to the listener', async () => {
    wireV6Modules()
    await new Promise(resolve => setImmediate(resolve))
    const probed = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('listener')
    })
    await new Promise<void>(resolve => probed.listen(0, '127.0.0.1', () => resolve()))
    const address = probed.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    const root = `http://127.0.0.1:${address.port}`
    try {
      const account = await fetch(`${root}/api/v6/account/board`)
      expect(account.status).toBe(200)
      const other = await fetch(`${root}/api/v6/workers`)
      expect(await other.text()).toBe('listener')
    } finally {
      Server.prototype.emit = savedEmit
      await new Promise<void>(resolve => probed.close(() => resolve()))
    }
  })
})

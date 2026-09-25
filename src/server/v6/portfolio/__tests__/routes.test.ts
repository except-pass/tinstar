import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isRecord } from '../../../../v6/contract/result'
import { emptyPortfolio } from '../../../../v6/portfolio/model'
import type { Epic, PlanView, PortfolioDoc, TaskRecord } from '../../../../v6/portfolio/types'
import { savePortfolio } from '../store'
import { registerPortfolioRoutes, type PortfolioReadReceipts, type PortfolioShellSubmit, type ShellSubmission } from '../routes'

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') resolve((address as AddressInfo).port)
      else reject(new Error('no port'))
    })
  })
}

function epic(partial: Partial<Epic> & Pick<Epic, 'id'>): Epic {
  return {
    title: partial.id,
    columnId: 'col-inbox',
    initiativeId: null,
    planSlug: null,
    completedAt: null,
    order: 0,
    revision: '1',
    ...partial,
  }
}

function task(partial: Partial<TaskRecord> & Pick<TaskRecord, 'id' | 'project'>): TaskRecord {
  return { epicId: null, planId: null, initiativeId: null, revision: '1', ...partial }
}

function fixtureBoard(partial: Partial<PortfolioDoc> = {}): PortfolioDoc {
  return { ...emptyPortfolio(), fixture: true, ...partial }
}

function intent(partial: Record<string, unknown>) {
  return {
    schema: 'tinstar.v6.intent/1',
    revision: '1',
    ...partial,
  }
}

interface ApiBody {
  ok: boolean
  data?: {
    board: PortfolioDoc
    submission?: { applied: boolean; disposition: string; detail: string }
    status?: string
    detail?: string
  }
  error?: { message: string }
}

describe('registerPortfolioRoutes', () => {
  const previousConfig = process.env.TINSTAR_CONFIG_HOME
  const previousPlan = process.env.STRETCHPLAN_URL

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.TINSTAR_CONFIG_HOME
    else process.env.TINSTAR_CONFIG_HOME = previousConfig
    if (previousPlan === undefined) delete process.env.STRETCHPLAN_URL
    else process.env.STRETCHPLAN_URL = previousPlan
  })

  function isolate() {
    const root = mkdtempSync(join(tmpdir(), 'tinstar-portfolio-'))
    process.env.TINSTAR_CONFIG_HOME = root
    process.env.STRETCHPLAN_URL = 'http://127.0.0.1:9'
    process.env.TINSTAR_V6_FM_HOME = join(root, 'fm-home')
    process.env.FM_V6_BIN = join(root, 'bin')
    return { root, file: join(root, 'v6', 'portfolio.json') }
  }

  async function withServer(
    opts: {
      file: string
      home: string
      submitIntent?: PortfolioShellSubmit
      readReceipts?: PortfolioReadReceipts
      fetchPlan?: (slug: string) => Promise<PlanView>
      projectionFile?: string
    },
    run: (port: number) => Promise<void>,
  ) {
    const server = createServer()
    const submitIntent = opts.submitIntent ?? (async () => {
      throw new Error('submitIntent was not expected')
    })
    registerPortfolioRoutes(server, {
      projectionFile: opts.projectionFile ?? opts.file,
      home: opts.home,
      binDir: join(opts.home, '..', 'bin'),
      submitIntent,
      readReceipts: opts.readReceipts ?? (async () => ({ reply: null })),
      fetchPlan: opts.fetchPlan,
    })
    const port = await listen(server)
    try {
      await run(port)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }

  function shell(result: Partial<ShellSubmission> = {}): { submitIntent: PortfolioShellSubmit; calls: unknown[] } {
    const calls: unknown[] = []
    const submitIntent: PortfolioShellSubmit = async raw => {
      calls.push(raw)
      const requestId = isRecord(raw) && typeof raw.requestId === 'string' ? raw.requestId : ''
      return {
        noteId: 'note-1',
        disposition: 'queued',
        applied: false,
        announced: true,
        canReceive: true,
        exitCode: 0,
        detail: 'queued',
        noteOutcome: calls.length > 1 ? 'replay' : 'created',
        ...result,
        requestId,
      }
    }
    return { submitIntent, calls }
  }

  async function post(port: number, path: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  }

  it('does not write the seed while browsing', async () => {
    const { root, file } = isolate()
    await withServer({ file, home: root }, async port => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v6/portfolio`)
      const body = await res.json() as ApiBody
      expect(res.status).toBe(200)
      expect(existsSync(file)).toBe(false)
      expect(body.data?.board.columns.map(column => column.id)).toEqual(['col-inbox', 'col-shaping', 'col-building', 'col-review'])
      expect(body.data?.board.fixture).toBe(false)
    })
  })

  it('keeps a move pending until the applied receipt', async () => {
    const { root, file } = isolate()
    const doc = fixtureBoard({ epics: [epic({ id: 'epic-containment-marker' })] })
    savePortfolio(file, doc)
    const before = readFileSync(file, 'utf8')
    const fake = shell()
    const readReceipts = vi.fn<PortfolioReadReceipts>(async (_opts, requestId) => ({
      reply: {
        requestId,
        body: JSON.stringify({
          schema: 'tinstar.v6.receipt/1',
          requestId,
          outcome: 'applied',
          detail: 'moved',
        }),
      },
    }))
    await withServer({ file, home: root, submitIntent: fake.submitIntent, readReceipts }, async port => {
      const browsing = await fetch(`http://127.0.0.1:${port}/api/v6/portfolio`)
      expect(browsing.status).toBe(200)
      expect(readFileSync(file, 'utf8')).toBe(before)

      const moved = await post(port, '/api/v6/portfolio/intent', intent({
        kind: 'portfolio.mutate',
        requestId: 'req-move',
        anchor: { type: 'epic', ids: ['epic-containment-marker'] },
        body: { op: 'move', epicId: 'epic-containment-marker', toColumnId: 'col-building', order: 0 },
      }))
      const pendingBody = await moved.json() as ApiBody
      expect(moved.status).toBe(200)
      expect(pendingBody.data?.submission).toMatchObject({ applied: false, disposition: 'queued' })
      expect(pendingBody.data?.board.epics[0]?.columnId).toBe('col-inbox')
      expect(fake.calls).toHaveLength(1)
      expect(fake.calls[0]).toMatchObject({ kind: 'portfolio.mutate', requestId: 'req-move' })

      const again = await post(port, '/api/v6/portfolio/intent', intent({
        kind: 'portfolio.mutate',
        requestId: 'req-move',
        anchor: { type: 'epic', ids: ['epic-containment-marker'] },
        body: { op: 'move', epicId: 'epic-containment-marker', toColumnId: 'col-review', order: 0 },
      }))
      const replay = await again.json() as ApiBody
      expect(replay.data?.board.pending).toHaveLength(1)
      expect(replay.data?.board.pending[0]).toMatchObject({ noteId: 'note-1', noteOutcome: 'replay', applied: false })
      expect(replay.data?.board.pending[0]?.proposal).toMatchObject({ toColumnId: 'col-building' })
      expect(fake.calls).toHaveLength(2)

      const reconciled = await post(port, '/api/v6/portfolio/reconcile', { requestId: 'req-move' })
      const applied = await reconciled.json() as ApiBody
      expect(applied.data?.status).toBe('applied')
      expect(applied.data?.board.epics[0]?.columnId).toBe('col-building')
      expect(applied.data?.board.epics[0]?.completedAt).toBeNull()

      const stored = readFileSync(file, 'utf8')
      const second = await post(port, '/api/v6/portfolio/reconcile', { requestId: 'req-move' })
      expect(second.status).toBe(200)
      expect(readFileSync(file, 'utf8')).toBe(stored)
    })
    const real = join(homedir(), '.config', 'tinstar', 'v6', 'portfolio.json')
    if (existsSync(real)) expect(readFileSync(real, 'utf8')).not.toContain('epic-containment-marker')
    expect(file.startsWith(root)).toBe(true)
  })

  it('explains rejected, exit 1, exit 3, and can_receive without applying', async () => {
    const { root, file } = isolate()
    savePortfolio(file, fixtureBoard({ epics: [epic({ id: 'epic-1' })] }))
    const cases: Array<{ id: string; result: Partial<ShellSubmission>; disposition: string; detail: string }> = [
      { id: 'req-exit-1', result: { exitCode: 1, disposition: 'failed', noteId: null, canReceive: null }, disposition: 'failed', detail: 'Nothing saved' },
      { id: 'req-exit-3', result: { exitCode: 3, disposition: 'saved-unannounced', canReceive: true }, disposition: 'saved-unannounced', detail: 'Saved, not announced' },
      { id: 'req-ready', result: { exitCode: 0, disposition: 'queued', canReceive: false, applied: true }, disposition: 'not-receivable', detail: 'Not receivable' },
    ]
    for (const item of cases) {
      const fake = shell(item.result)
      await withServer({ file, home: root, submitIntent: fake.submitIntent }, async port => {
        const res = await post(port, '/api/v6/portfolio/intent', intent({
          kind: 'portfolio.mutate',
          requestId: item.id,
          anchor: { type: 'epic', ids: ['epic-1'] },
          body: { op: 'move', epicId: 'epic-1', toColumnId: 'col-building', order: 0 },
        }))
        const body = await res.json() as ApiBody
        expect(body.data?.submission).toMatchObject({ applied: false, disposition: item.disposition, detail: item.detail })
        expect(body.data?.board.epics[0]?.columnId).toBe('col-inbox')
      })
    }
    const fake = shell()
    const readReceipts: PortfolioReadReceipts = async (_opts, requestId) => ({
      reply: {
        requestId,
        body: JSON.stringify({ schema: 'tinstar.v6.receipt/1', requestId, outcome: 'rejected', detail: 'column is full' }),
      },
    })
    await withServer({ file, home: root, submitIntent: fake.submitIntent, readReceipts }, async port => {
      await post(port, '/api/v6/portfolio/intent', intent({
        kind: 'portfolio.mutate',
        requestId: 'req-reject',
        anchor: { type: 'epic', ids: ['epic-1'] },
        body: { op: 'move', epicId: 'epic-1', toColumnId: 'col-building', order: 0 },
      }))
      const res = await post(port, '/api/v6/portfolio/reconcile', { requestId: 'req-reject' })
      const body = await res.json() as ApiBody
      expect(body.data?.status).toBe('rejected')
      expect(body.data?.detail).toBe('column is full')
      expect(body.data?.board.epics[0]?.columnId).toBe('col-inbox')
    })
  })

  it('renames a column to Done without setting completedAt or launching', async () => {
    const { root, file } = isolate()
    savePortfolio(file, fixtureBoard({
      epics: [epic({ id: 'epic-1', columnId: 'col-review', completedAt: '2026-09-01T00:00:00.000Z' })],
    }))
    const fake = shell()
    const readReceipts: PortfolioReadReceipts = async (_opts, requestId) => ({
      reply: {
        requestId,
        body: JSON.stringify({ schema: 'tinstar.v6.receipt/1', requestId, outcome: 'applied', detail: 'renamed' }),
      },
    })
    await withServer({ file, home: root, submitIntent: fake.submitIntent, readReceipts }, async port => {
      const posted = await post(port, '/api/v6/portfolio/intent', intent({
        kind: 'column.mutate',
        requestId: 'req-rename',
        anchor: { type: 'selection', ids: ['col-review'] },
        body: { op: 'rename', columnId: 'col-review', name: 'Done', description: 'Finished for now' },
      }))
      expect(posted.status).toBe(200)
      const reconciled = await post(port, '/api/v6/portfolio/reconcile', { requestId: 'req-rename' })
      const body = await reconciled.json() as ApiBody
      expect(body.data?.board.columns.find(column => column.id === 'col-review')).toMatchObject({
        name: 'Done',
        description: 'Finished for now',
      })
      expect(body.data?.board.epics[0]?.completedAt).toBe('2026-09-01T00:00:00.000Z')
      expect(body.data?.board.launches).toEqual([])
      expect(fake.calls.map(call => isRecord(call) ? call.kind : '')).toEqual(['column.mutate'])
    })
  })

  it('persists a launch from the ancestors that were supplied', async () => {
    const { root, file } = isolate()
    savePortfolio(file, fixtureBoard({
      epics: [epic({ id: 'epic-1', initiativeId: 'init-1', planSlug: 'pm-demo' })],
      initiatives: [{ id: 'init-1', name: 'Rivers', epicIds: ['epic-1'], projectIds: ['proj-a', 'proj-b'], revision: '1' }],
      tasks: [task({ id: 'task-1', project: 'proj-a', epicId: 'epic-1', planId: 'pm-demo', initiativeId: 'init-1' })],
    }))
    const fake = shell()
    const readReceipts: PortfolioReadReceipts = async (_opts, requestId) => ({
      reply: {
        requestId,
        body: JSON.stringify({ schema: 'tinstar.v6.receipt/1', requestId, outcome: 'applied', detail: 'recorded' }),
      },
    })
    await withServer({ file, home: root, submitIntent: fake.submitIntent, readReceipts }, async port => {
      const posted = await post(port, '/api/v6/portfolio/intent', intent({
        kind: 'launch.request',
        requestId: 'req-launch',
        anchor: { type: 'task', ids: ['task-1'] },
        body: { taskId: 'task-1', project: 'proj-a', epicId: 'epic-1', planId: 'pm-demo' },
      }))
      const pending = await posted.json() as ApiBody
      expect(pending.data?.board.launches).toEqual([])
      expect(pending.data?.board.pending[0]?.proposal).toMatchObject({
        op: 'launch',
        launch: { project: 'proj-a', epicId: 'epic-1', planId: 'pm-demo', initiativeId: null },
      })
      const reconciled = await post(port, '/api/v6/portfolio/reconcile', { requestId: 'req-launch' })
      const body = await reconciled.json() as ApiBody
      expect(body.data?.board.launches[0]).toMatchObject({
        taskId: 'task-1',
        project: 'proj-a',
        epicId: 'epic-1',
        planId: 'pm-demo',
        initiativeId: null,
      })
      expect(body.data?.board.epics[0]?.initiativeId).toBe('init-1')
      expect(body.data?.board.dependencies).toEqual([])
      expect(fake.calls[0]).toMatchObject({ kind: 'launch.request' })

      const wrong = await post(port, '/api/v6/portfolio/intent', intent({
        kind: 'launch.request',
        requestId: 'req-wrong-project',
        anchor: { type: 'task', ids: ['task-1'] },
        body: { taskId: 'task-1', project: 'proj-b' },
      }))
      expect(wrong.status).toBe(400)
      expect(fake.calls).toHaveLength(1)
    })
  })

  it('refuses a command field, a non-json body, a plan write, and a path outside the config root', async () => {
    const { root, file } = isolate()
    const fetchPlan = vi.fn(async () => ({
      available: true, fixture: false, slug: 'pm-demo', href: null, tasks: [], detail: '',
    }))
    const fake = shell()
    await withServer({ file, home: root, submitIntent: fake.submitIntent, fetchPlan }, async port => {
      const commanded = await post(port, '/api/v6/portfolio/intent', { command: 'rm', requestId: 'req-x' })
      expect(commanded.status).toBe(403)
      const plain = await fetch(`http://127.0.0.1:${port}/api/v6/portfolio/intent`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: '{}',
      })
      expect(plain.status).toBe(415)
      const posted = await post(port, '/api/v6/portfolio/plans/pm-demo', { tasks: [] })
      expect(posted.status).toBe(405)
      expect(fetchPlan).not.toHaveBeenCalled()
      const read = await fetch(`http://127.0.0.1:${port}/api/v6/portfolio/plans/pm-demo`)
      expect(read.status).toBe(200)
      expect(fetchPlan).toHaveBeenCalledWith('pm-demo')
      expect(fake.calls).toHaveLength(0)
    })

    const outside = join(tmpdir(), `portfolio-outside-${process.pid}`, 'portfolio.json')
    await withServer({ file, home: root, projectionFile: outside, submitIntent: fake.submitIntent }, async port => {
      const res = await fetch(`http://127.0.0.1:${port}/api/v6/portfolio`)
      expect(res.status).toBe(403)
      expect(existsSync(outside)).toBe(false)
    })
  })

  it('leaves other routes untouched', async () => {
    const { root, file } = isolate()
    const server = createServer()
    const handle = registerPortfolioRoutes(server, { projectionFile: file, home: root })
    const req = new (await import('node:http')).IncomingMessage(new (await import('node:net')).Socket())
    req.method = 'GET'
    req.url = '/api/sessions'
    const res = new (await import('node:http')).ServerResponse(req)
    await expect(handle(req, res)).resolves.toBe(false)
    expect(res.headersSent).toBe(false)
    server.close()
  })
})

/**
 * T15. An open attention item survives the originating worker's record going
 * away. An answer saved into the temp config home and the temp First Mate home
 * is still there after a new UI server and a new inbox process, and a receipt
 * applies once. Unanswered, queued, and resolved stay distinct.
 *
 * Both directories are fixtures this test creates. A live First Mate is not
 * started or restarted. Restart keeps those directories and drops the process.
 */
import { execFileSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterAll, describe, expect, it } from 'vitest'
import { decisionFixture } from '../needsyou/fixtures'
import { NeedsYouRail } from '../needsyou/NeedsYouRail'
import { readAttention } from '../../server/v6/needsyou/store'
import { registerNeedsYouRoutes } from '../../server/v6/needsyou/routes'
import { listWorkerDescriptors } from '../../server/v6/shell/snapshot'
import { readReceipts, submitIntent } from '../../server/v6/shell/submitIntent'

const BIN = process.env.FM_V6_BIN
  ?? '/Users/wtg/.local/state/pm-build/tinstar-v6/worktrees/fm-boundary/bin'
const binDir = BIN.endsWith('.sh') ? join(BIN, '..') : BIN
const WORKER = 'origin-t15'
const ORIGIN = 'ny-origin'
const OPEN = 'ny-open'
const QUEUED = 'ny-queued'
const RESOLVED = 'ny-resolved'

const savedEnv: Record<string, string | undefined> = {}

function remember(key: string): void {
  savedEnv[key] = process.env[key]
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

function childEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, FM_HOME: home }
  delete env.TMUX
  delete env.TMUX_PANE
  delete env.NODE_ENV
  for (const key of Object.keys(env)) {
    if (key.startsWith('FM_') && key.endsWith('_OVERRIDE')) delete env[key]
  }
  delete env.FM_TEST_HOME
  return env
}

function meta(home: string): void {
  mkdirSync(join(home, 'state'), { recursive: true })
  mkdirSync(join(home, 'data'), { recursive: true })
  writeFileSync(join(home, 'FIXTURE'), 'fixture\n')
  writeFileSync(join(home, 'state', `${WORKER}.meta`), [
    'spawn_gen=1',
    'project=fixture-project',
    'backend=tmux',
    `window=${WORKER}:main`,
    'worktree=/tmp/t15-origin-worktree',
    'kind=ship',
    'harness=claude',
    'mode=ship',
    'yolo=off',
    '',
  ].join('\n'))
}

interface PublicItem {
  delivery: string
  applied: boolean
  answerRequestId: string | null
  receiptDetail: string | null
  item: { id: string; state: string; provenance?: { workerId?: string }; response: { body: Record<string, unknown> } | null }
}

function dataOf(body: unknown): PublicItem {
  const record = body as { data: PublicItem }
  return record.data
}

function itemsOf(body: unknown): PublicItem[] {
  const record = body as { data: { items: PublicItem[] } }
  return record.data.items
}

describe('T15 attention durability', () => {
  const dirs: string[] = []
  let config = ''
  let home = ''
  let base = ''
  let server: Server | null = null

  afterAll(async () => {
    if (server) await new Promise<void>(resolve => server?.close(() => resolve()))
    restoreEnv()
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })

  async function listen(): Promise<void> {
    if (server) await new Promise<void>(resolve => server?.close(() => resolve()))
    const handle = registerNeedsYouRoutes({
      submitIntent,
      inbox: { home, binDir },
      now: () => '2026-09-25T04:00:00.000Z',
    })
    server = createServer((req, res) => {
      void handle(req, res).then(handled => {
        if (!handled && !res.headersSent) {
          res.statusCode = 404
          res.end()
        }
      })
    })
    await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', () => resolve()))
    const address = server?.address() as AddressInfo
    expect(address.port).not.toBe(5280)
    expect(address.port).not.toBe(5281)
    base = `http://127.0.0.1:${address.port}`
  }

  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function http() {
    return {
      async list() {
        return fetch(`${base}/api/v6/needsyou`).then(res => res.json()) as Promise<unknown>
      },
      async answer(id: string, body: { revision: string; requestId: string; kind: 'attention.answer' | 'schedule.acknowledge'; body: Record<string, unknown> }) {
        const res = await post(`/api/v6/needsyou/${id}/answer`, body)
        return res.json() as Promise<unknown>
      },
    }
  }

  it('keeps an open item after the worker is gone, and applies one restarted answer', async () => {
    expect(existsSync(join(binDir, 'fm-inbox.sh'))).toBe(true)
    expect(existsSync(join(binDir, 'fm-fleet-snapshot.sh'))).toBe(true)
    config = mkdtempSync(join(tmpdir(), 't15-config-'))
    home = mkdtempSync(join(tmpdir(), 't15-fm-'))
    dirs.push(config, home)
    for (const key of ['TINSTAR_CONFIG_HOME', 'TINSTAR_V6_FM_HOME', 'FM_V6_BIN', 'TINSTAR_V6_FIXTURE', 'FM_HOME', 'TMUX', 'NODE_ENV']) {
      remember(key)
    }
    process.env.TINSTAR_CONFIG_HOME = config
    process.env.TINSTAR_V6_FM_HOME = home
    process.env.FM_V6_BIN = binDir
    process.env.TINSTAR_V6_FIXTURE = '1'
    delete process.env.TMUX
    delete process.env.NODE_ENV
    meta(home)

    const listed = await listWorkerDescriptors({ home, configured: true, binDir, fixture: true })
    expect(listed.workers.map(worker => worker.id)).toContain(WORKER)

    await listen()
    const origin = await post('/api/v6/needsyou/items', decisionFixture({
      id: ORIGIN,
      headline: 'Keep this decision after the worker exits',
      provenance: { workerId: WORKER, taskId: 't15' },
    }))
    expect(origin.status).toBe(200)
    expect(dataOf(await origin.json()).item.state).toBe('open')

    const open = await post('/api/v6/needsyou/items', decisionFixture({
      id: OPEN,
      headline: 'Still unanswered',
      provenance: { workerId: WORKER },
    }))
    expect(open.status).toBe(200)

    const resolved = await post('/api/v6/needsyou/items', decisionFixture({
      id: RESOLVED,
      headline: 'Already resolved',
      state: 'resolved',
      provenance: { workerId: WORKER },
    }))
    expect(resolved.status).toBe(200)

    const queuedItem = decisionFixture({
      id: QUEUED,
      headline: 'Queued and not resolved',
      state: 'answered',
      provenance: { workerId: WORKER },
      response: {
        revision: 'rev-decision',
        at: '2026-09-25T03:00:00.000Z',
        body: { optionId: 'keep' },
      },
    })
    const queued = await post('/api/v6/needsyou/items', {
      fixture: true,
      delivery: 'queued',
      answerRequestId: 'req-queued',
      spentRequestIds: [],
      lastError: null,
      receiptDetail: null,
      acknowledgement: null,
      item: queuedItem,
    })
    expect(queued.status).toBe(200)
    const queuedBody = dataOf(await queued.json())
    expect(queuedBody.delivery).toBe('queued')
    expect(queuedBody.item.state).toBe('answered')

    rmSync(join(home, 'state', `${WORKER}.meta`))
    const gone = await listWorkerDescriptors({ home, configured: true, binDir, fixture: true })
    expect(gone.workers.map(worker => worker.id)).not.toContain(WORKER)
    let taskText = ''
    try {
      taskText = execFileSync(join(binDir, 'fm-fleet-snapshot.sh'), ['--task', WORKER, '--json'], {
        env: childEnv(home),
        encoding: 'utf8',
      })
    } catch (err) {
      const failed = err as { stdout?: string; status?: number }
      taskText = String(failed.stdout ?? '')
      expect(failed.status).not.toBe(0)
    }
    expect(taskText).toMatch(/not-found|"found": false/)

    const afterExit = itemsOf(await (await fetch(`${base}/api/v6/needsyou`)).json())
    const surviving = afterExit.find(row => row.item.id === ORIGIN)
    expect(surviving?.item.state).toBe('open')
    expect(surviving?.delivery).toBe('unanswered')
    expect(surviving?.item.provenance?.workerId).toBe(WORKER)
    expect(surviving?.applied).toBe(false)

    const shown = render(createElement(NeedsYouRail, { http: http() }))
    await waitFor(() => expect(screen.getByTestId(`needsyou-card-${ORIGIN}`)).toHaveAttribute('data-state', 'open'))
    expect(screen.getByTestId(`needsyou-status-${OPEN}`)).toHaveTextContent('unanswered')
    expect(screen.getByTestId(`needsyou-status-${QUEUED}`)).toHaveTextContent('queued')
    expect(screen.getByTestId(`needsyou-status-${QUEUED}`).textContent).not.toMatch(/resolved/)
    expect(screen.getByTestId(`needsyou-state-${RESOLVED}`)).toHaveTextContent('state resolved')
    expect(screen.getByTestId(`needsyou-status-${RESOLVED}`).textContent).not.toMatch(/queued/)
    expect(screen.getByTestId(`needsyou-origin-${ORIGIN}`)).toHaveTextContent(WORKER)

    fireEvent.click(within(screen.getByTestId(`needsyou-card-${ORIGIN}`)).getByRole('button', { name: 'Keep one queue' }))
    await waitFor(() => expect(screen.getByTestId(`needsyou-card-${ORIGIN}`)).toHaveAttribute('data-state', 'answered'))
    const answeredCard = screen.getByTestId(`needsyou-card-${ORIGIN}`)
    expect(answeredCard).toHaveAttribute('data-applied', 'false')
    expect(answeredCard.getAttribute('data-delivery')).not.toBe('unanswered')
    expect(answeredCard.getAttribute('data-state')).not.toBe('resolved')
    shown.unmount()

    const stored = readAttention(join(config, 'v6', 'needsyou')).items.find(row => row.item.id === ORIGIN)
    expect(stored?.item.state).toBe('answered')
    expect(stored?.item.state).not.toBe('resolved')
    expect(stored?.delivery === 'queued' || stored?.delivery === 'not-receivable' || stored?.delivery === 'saved-unannounced').toBe(true)
    const requestId = stored?.answerRequestId
    expect(requestId).toBeTruthy()
    const projection = JSON.parse(readFileSync(join(config, 'v6', 'projection.json'), 'utf8')) as {
      intents: Record<string, { noteId: string | null }>
    }
    const noteId = projection.intents[requestId ?? '']?.noteId
    expect(noteId).toBeTruthy()
    expect(existsSync(join(home, 'state', 'inbox', `${noteId}.note`))).toBe(true)

    await listen()
    const reread = await readReceipts({ home, binDir }, requestId ?? '')
    expect(reread.reply).toBeNull()
    const reloaded = readAttention(join(config, 'v6', 'needsyou')).items
    const originAgain = reloaded.find(row => row.item.id === ORIGIN)
    const openAgain = reloaded.find(row => row.item.id === OPEN)
    const queuedAgain = reloaded.find(row => row.item.id === QUEUED)
    const resolvedAgain = reloaded.find(row => row.item.id === RESOLVED)
    expect(originAgain?.item.response?.body).toEqual({ optionId: 'keep', comment: 'fixture comment' })
    expect(originAgain?.delivery).not.toBe('unanswered')
    expect(originAgain?.item.state).not.toBe('resolved')
    expect(openAgain?.item.state).toBe('open')
    expect(openAgain?.delivery).toBe('unanswered')
    expect(queuedAgain?.delivery).toBe('queued')
    expect(queuedAgain?.item.state).toBe('answered')
    expect(queuedAgain?.item.state).not.toBe('resolved')
    expect(resolvedAgain?.item.state).toBe('resolved')
    expect(resolvedAgain?.delivery).not.toBe('queued')

    const remounted = render(createElement(NeedsYouRail, { http: http() }))
    await waitFor(() => expect(screen.getByTestId(`needsyou-card-${ORIGIN}`)).toHaveAttribute('data-state', 'answered'))
    expect(screen.getByTestId(`needsyou-status-${OPEN}`)).toHaveTextContent('unanswered')
    expect(screen.getByTestId(`needsyou-status-${QUEUED}`)).toHaveTextContent('queued')
    expect(screen.getByTestId(`needsyou-state-${RESOLVED}`)).toHaveTextContent('state resolved')
    remounted.unmount()

    const receipt = {
      schema: 'tinstar.v6.receipt/1',
      requestId,
      outcome: 'applied',
      detail: 'applied once',
    }
    execFileSync(join(binDir, 'fm-inbox.sh'), ['reply', '--json', noteId ?? '', JSON.stringify(receipt)], {
      env: childEnv(home),
      encoding: 'utf8',
    })
    const replied = await readReceipts({ home, binDir }, requestId ?? '')
    expect(replied.reply?.appliedOutcome).toBe('applied')
    expect(replied.reply?.requestId).toBe(requestId)

    const first = await post('/api/v6/needsyou/receipts', receipt)
    expect(first.status).toBe(200)
    const firstBody = await first.json() as { data: { changed: boolean; applied: boolean; item: PublicItem } }
    expect(firstBody.data.changed).toBe(true)
    expect(firstBody.data.applied).toBe(true)
    expect(firstBody.data.item.delivery).toBe('applied')
    expect(firstBody.data.item.item.state).toBe('answered')
    expect(firstBody.data.item.item.state).not.toBe('resolved')

    const second = await post('/api/v6/needsyou/receipts', { ...receipt, outcome: 'rejected', detail: 'too late' })
    const secondBody = await second.json() as { data: { changed: boolean; item: PublicItem } }
    expect(secondBody.data.changed).toBe(false)
    expect(secondBody.data.item.delivery).toBe('applied')
    expect(secondBody.data.item.item.state).toBe('answered')
    expect(secondBody.data.item.receiptDetail).toBe('applied once')

    const finalRows = readAttention(join(config, 'v6', 'needsyou')).items
    expect(finalRows.find(row => row.item.id === OPEN)?.delivery).toBe('unanswered')
    expect(finalRows.find(row => row.item.id === QUEUED)?.delivery).toBe('queued')
    expect(finalRows.find(row => row.item.id === RESOLVED)?.item.state).toBe('resolved')
    expect(finalRows.find(row => row.item.id === ORIGIN)?.delivery).toBe('applied')
    expect(finalRows.find(row => row.item.id === ORIGIN)?.item.state).toBe('answered')
  }, 60_000)
})

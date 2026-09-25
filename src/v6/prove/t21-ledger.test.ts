/**
 * @vitest-environment node
 *
 * T21: duplicate and out-of-order ledger records, missing history, and a failed
 * observation must not add a worker, mark one complete, or call it healthy.
 * Ledger lines are a fixture under a temp home. The live ledger is not read.
 */
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FmCommandRunner } from '../../server/v6/shell/fmExec'
import { handleV6Http, setV6RouteDepsForTests } from '../../server/v6/shell/routes'
import { V6Views, type V6ViewDeps } from '../../server/v6/shell/views'

const LIVE_LEDGER_ROOTS = [
  '/Users/wtg/repo/firstmate',
  '/Users/wtg/.local/state/pm-build/tinstar-v6/firstmate-home',
]

interface ListedWorker {
  id: string
  crewState: string
  endpoint: { agentAlive: string; status: string; target: string | null }
}

interface Observation {
  status: string
  health: string
  completion: string
  duplicateRecords: number
  outOfOrder: boolean
  missingHistory: string[]
  notWorkers: string[]
  diagnostic: string | null
}

interface Listed {
  configured: boolean
  workers: ListedWorker[]
  diagnostics: string[]
  observation: Observation
  unobserved: { id: string; health: string; completion: string; reason: string }[]
}

const dispatchedA = {
  v: 1,
  ts: 2,
  event: 'task.dispatched',
  task: 'worker-a',
  kind: 'ship',
  project: 'alpha',
  harness: 'grok',
  model: null,
}

const MESSY: unknown[] = [
  { v: 1, ts: 1, event: 'task.cleaned_up', task: 'worker-a' },
  dispatchedA,
  dispatchedA,
  { v: 1, ts: 3, event: 'task.status', task: 'worker-a', state: 'done', key: null, text: ' false completion' },
  { v: 1, ts: 4, event: 'task.dispatched', task: 'worker-ghost', kind: 'ship', project: 'alpha', harness: 'grok', model: null },
  { v: 1, ts: 5, event: 'task.status', task: 'worker-ghost', state: 'done', key: null, text: ' false healthy', healthy: true, complete: true },
  { v: 1, ts: 6, event: 'task.merged', task: 'worker-ghost', via: 'local' },
  { v: 1, ts: 7, event: 'task.status', task: 'worker-a', state: 'working', key: null, text: ' still working' },
  { v: 1, ts: 8, event: 'task.status', task: 'worker-b', state: 'done', key: null, text: ' no dispatch history' },
  { v: 1, ts: 1, event: 'task.status', task: 'worker-a', state: 'done', key: null, text: ' late replay of an older done' },
]

const TRUNCATED = JSON.stringify({
  v: 1,
  ts: 9,
  event: 'task.dispatched',
  task: 'worker-truncated',
  kind: 'ship',
  project: 'alpha',
  harness: 'grok',
  model: null,
})

function ledgerText(records: unknown[], partial?: string): string {
  const body = records.map(record => JSON.stringify(record)).join('\n') + '\n'
  return partial ? body + partial : body
}

function taskObject(id: string, state: string, alive: string) {
  return {
    id,
    fixture: true,
    project: 'alpha',
    spawn_gen: '4',
    backend: 'tmux',
    paths: { worktree: { path: `/tmp/${id}`, present: true } },
    endpoint: { target: `v6fix:${id}`, exists: true, agent_alive: alive, status: alive },
    current_state: { state, observed_at: '2026-09-25T12:00:00Z' },
    actions: { steer: 'bin/fm-send.sh do not leak' },
  }
}

function notFoundObject(id: string) {
  return { schema: 'fm-fleet-snapshot-task.v1', found: false, id, reason: 'not-found' }
}

type Mode = 'ok' | 'fail' | 'fleet' | 'missing' | 'throw'

function runner(mode: Mode): FmCommandRunner {
  return {
    exec: async (_script, args) => {
      if (mode === 'throw') throw new Error('observation exploded')
      if (args[0] === '--task') {
        const id = args[1] ?? ''
        if (mode === 'fleet') return { code: 2, stdout: '', stderr: 'usage: fm-fleet-snapshot [--json]' }
        if (mode === 'fail') return { code: 1, stdout: '', stderr: 'snapshot failed' }
        if (mode === 'missing' && id === 'worker-a') {
          return { code: 1, stdout: JSON.stringify(notFoundObject(id)), stderr: '' }
        }
        return { code: 0, stdout: JSON.stringify(taskObject(id, 'working', 'unknown')), stderr: '' }
      }
      if (mode === 'fleet') {
        return {
          code: 0,
          stdout: JSON.stringify({
            tasks: [
              taskObject('worker-a', 'done', 'alive'),
              taskObject('worker-a', 'working', 'unknown'),
              taskObject('worker-ghost', 'done', 'alive'),
            ],
          }),
          stderr: '',
        }
      }
      return { code: 1, stdout: '', stderr: 'unexpected snapshot argv' }
    },
  }
}

function viewDeps(): V6ViewDeps {
  return {
    tmux: async () => '',
    spawnTtyd: () => { throw new Error('ttyd is not used') },
    ttydRefusal: () => 'not used',
    healthCheck: async () => false,
    claimPort: async () => { throw new Error('port is not used') },
    releasePort: () => undefined,
  }
}

function req(url: string): IncomingMessage {
  const emitter = new EventEmitter() as IncomingMessage
  emitter.method = 'GET'
  emitter.url = url
  emitter.headers = {}
  process.nextTick(() => emitter.emit('end'))
  return emitter
}

function res() {
  const response = {
    statusCode: 0,
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status: number) {
      this.statusCode = status
      this.headersSent = true
      return this
    },
    end(payload?: string) {
      this.body = payload ?? ''
      this.writableEnded = true
      return this
    },
  }
  return response as unknown as ServerResponse & { statusCode: number; body: string }
}

const homes: string[] = []

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 't21-ledger-'))
  for (const root of LIVE_LEDGER_ROOTS) {
    if (home === root || home.startsWith(`${root}/`)) {
      throw new Error(`fixture home must not be the live ledger root: ${home}`)
    }
  }
  mkdirSync(join(home, 'state'))
  homes.push(home)
  return home
}

function writeMeta(home: string, ids: string[]) {
  for (const id of ids) writeFileSync(join(home, 'state', `${id}.meta`), 'backend=tmux\n')
}

function writeLedger(home: string, text: string) {
  writeFileSync(join(home, 'state', 'fleet-ledger.jsonl'), text)
}

function mount(home: string, mode: Mode, configured = true) {
  setV6RouteDepsForTests({
    views: new V6Views(viewDeps(), '/opt/tinstar/bin/tinstar-v6-view'),
    runner: runner(mode),
    projectionFile: join(home, 'projection.json'),
    home,
    configured,
    binDir: '/tmp/t21-fm-bin',
  })
}

async function getWorkers(): Promise<{ status: number; body: string; data: Listed | null }> {
  const response = res()
  await handleV6Http(req('/api/v6/workers'), response)
  const parsed = JSON.parse(response.body) as { ok?: boolean; data?: Listed }
  return { status: response.statusCode, body: response.body, data: parsed.ok ? (parsed.data ?? null) : null }
}

function idsOf(data: Listed): string[] {
  return data.workers.map(worker => worker.id)
}

afterEach(() => {
  setV6RouteDepsForTests(null)
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('T21 ledger honesty', () => {
  it('does not duplicate workers, complete them, or call them healthy from a messy fixture ledger', async () => {
    const home = tempHome()
    writeMeta(home, ['worker-a', 'worker-b', 'worker-c'])
    writeLedger(home, ledgerText(MESSY, TRUNCATED))
    mount(home, 'ok')

    const { body, data } = await getWorkers()
    expect(data).not.toBeNull()
    const listed = data!
    expect(idsOf(listed)).toEqual(['worker-a', 'worker-b', 'worker-c'])
    expect(new Set(idsOf(listed)).size).toBe(listed.workers.length)
    for (const worker of listed.workers) {
      expect(worker.crewState).toBe('working')
      expect(worker.endpoint.agentAlive).toBe('unknown')
      expect(worker.endpoint.status).not.toBe('alive')
    }
    expect(listed.observation).toMatchObject({
      status: 'read',
      health: 'unknown',
      completion: 'unknown',
      duplicateRecords: 1,
      outOfOrder: true,
      missingHistory: ['worker-b', 'worker-c'],
      notWorkers: ['worker-ghost'],
      diagnostic: null,
    })
    expect(listed.unobserved).toEqual([])
    expect(body).not.toContain('"crewState":"done"')
    expect(body).not.toContain('"agentAlive":"alive"')
    expect(body).not.toContain('"healthy":true')
    expect(body).not.toContain('"complete":true')
    expect(body).not.toContain('worker-truncated')
    expect(body).not.toContain('fm-send')
    expect(existsSync(join(home, 'state', 'worker-ghost.meta'))).toBe(false)
  })

  it('does not invent a worker from ledger lines when no meta exists', async () => {
    const home = tempHome()
    writeLedger(home, ledgerText(MESSY, TRUNCATED))
    mount(home, 'ok')

    const { data } = await getWorkers()
    expect(data!.configured).toBe(true)
    expect(data!.workers).toEqual([])
    expect(data!.observation.health).toBe('unknown')
    expect(data!.observation.completion).toBe('unknown')
    expect(data!.observation.notWorkers).toEqual(['worker-a', 'worker-b', 'worker-ghost'])
    expect(data!.observation.notWorkers).not.toContain('worker-truncated')
    expect(data!.unobserved).toEqual([])
  })

  it('keeps a snapshot not-found worker absent when the ledger says it is done', async () => {
    const home = tempHome()
    writeMeta(home, ['worker-a', 'worker-b', 'worker-c'])
    writeLedger(home, ledgerText(MESSY))
    mount(home, 'missing')

    const { body, data } = await getWorkers()
    expect(idsOf(data!)).toEqual(['worker-b', 'worker-c'])
    expect(data!.workers.every(worker => worker.crewState === 'working')).toBe(true)
    expect(data!.unobserved.map(row => row.id)).not.toContain('worker-a')
    expect(data!.observation.notWorkers).toEqual(['worker-ghost'])
    expect(data!.observation.completion).toBe('unknown')
    expect(data!.observation.health).toBe('unknown')
    expect(body).not.toContain('"crewState":"done"')
    expect(body).not.toContain('"agentAlive":"alive"')
  })

  it('reports a failed snapshot as unknown, not done or alive, and does not fill from the ledger', async () => {
    const home = tempHome()
    writeMeta(home, ['worker-a', 'worker-b'])
    writeLedger(home, ledgerText(MESSY))
    mount(home, 'fail')

    const { body, data } = await getWorkers()
    expect(idsOf(data!)).toEqual(['worker-a', 'worker-b'])
    for (const worker of data!.workers) {
      expect(worker.crewState).toBe('unknown')
      expect(worker.endpoint.agentAlive).toBe('unknown')
      expect(worker.endpoint.status).toBe('unknown')
      expect(worker.endpoint.target).toBeNull()
    }
    expect(data!.unobserved.map(row => row.id)).toEqual(['worker-a', 'worker-b'])
    for (const row of data!.unobserved) {
      expect(row.health).toBe('unknown')
      expect(row.completion).toBe('unknown')
    }
    expect(data!.observation.notWorkers).toEqual(['worker-ghost'])
    expect(data!.observation.health).toBe('unknown')
    expect(data!.observation.completion).toBe('unknown')
    expect(body).not.toContain('"crewState":"done"')
    expect(body).not.toContain('"agentAlive":"alive"')
  })

  it('collapses duplicate conflicting fleet rows without a done or alive reading', async () => {
    const home = tempHome()
    writeMeta(home, ['worker-a', 'worker-b'])
    writeLedger(home, ledgerText(MESSY))
    mount(home, 'fleet')

    const { body, data } = await getWorkers()
    expect(idsOf(data!)).toEqual(['worker-a', 'worker-b'])
    const alpha = data!.workers.find(worker => worker.id === 'worker-a')
    expect(alpha?.crewState).toBe('unknown')
    expect(alpha?.endpoint.agentAlive).toBe('unknown')
    expect(alpha?.endpoint.target).toBeNull()
    expect(data!.workers.find(worker => worker.id === 'worker-b')?.crewState).toBe('unknown')
    expect(data!.observation.notWorkers).toEqual(['worker-ghost'])
    expect(data!.observation.completion).toBe('unknown')
    expect(body).not.toContain('"crewState":"done"')
    expect(body).not.toContain('"agentAlive":"alive"')
    expect(body).not.toContain('fm-send')
  })

  it('treats an unreadable ledger as a failed observation and leaves snapshot workers unchanged', async () => {
    const home = tempHome()
    writeMeta(home, ['worker-a'])
    mkdirSync(join(home, 'state', 'fleet-ledger.jsonl'))
    mount(home, 'ok')

    const { data } = await getWorkers()
    expect(idsOf(data!)).toEqual(['worker-a'])
    expect(data!.workers[0]?.crewState).toBe('working')
    expect(data!.workers[0]?.endpoint.agentAlive).toBe('unknown')
    expect(data!.observation.status).toBe('failed')
    expect(data!.observation.health).toBe('unknown')
    expect(data!.observation.completion).toBe('unknown')
    expect(data!.observation.notWorkers).toEqual([])
    expect(data!.observation.diagnostic).toBe('ledger path is not a file')
  })

  it('does not follow a ledger symlink into another file', async () => {
    const home = tempHome()
    writeMeta(home, ['worker-a'])
    const other = join(home, 'other-ledger.jsonl')
    writeFileSync(other, ledgerText([
      { v: 1, ts: 1, event: 'task.dispatched', task: 'worker-ghost', kind: 'ship', project: 'alpha', harness: 'grok', model: null },
      { v: 1, ts: 2, event: 'task.status', task: 'worker-ghost', state: 'done', key: null, text: ' false healthy', healthy: true },
      { v: 1, ts: 3, event: 'task.merged', task: 'worker-a', via: 'local', complete: true },
    ]))
    symlinkSync(other, join(home, 'state', 'fleet-ledger.jsonl'))
    mount(home, 'ok')

    const { body, data } = await getWorkers()
    expect(idsOf(data!)).toEqual(['worker-a'])
    expect(data!.workers[0]?.crewState).toBe('working')
    expect(data!.observation.status).toBe('failed')
    expect(data!.observation.diagnostic).toBe('ledger path is a symlink')
    expect(data!.observation.notWorkers).toEqual([])
    expect(data!.observation.health).toBe('unknown')
    expect(data!.observation.completion).toBe('unknown')
    expect(body).not.toContain('worker-ghost')
    expect(body).not.toContain('"healthy":true')
  })

  it('does not read a ledger when the home is unconfigured', async () => {
    const home = tempHome()
    mkdirSync(join(home, 'state', 'fleet-ledger.jsonl'))
    writeMeta(home, ['worker-a'])
    mount(home, 'throw', false)

    const { data } = await getWorkers()
    expect(data!.configured).toBe(false)
    expect(data!.workers).toEqual([])
    expect(data!.observation.status).toBe('absent')
    expect(data!.observation.health).toBe('unknown')
    expect(data!.observation.completion).toBe('unknown')
  })

  it('returns an error instead of a healthy worker list when observation throws', async () => {
    const home = tempHome()
    writeMeta(home, ['worker-a'])
    writeLedger(home, ledgerText(MESSY))
    mount(home, 'throw')

    const { status, body, data } = await getWorkers()
    expect(status).toBe(500)
    expect(data).toBeNull()
    expect(body).not.toContain('"crewState":"done"')
    expect(body).not.toContain('"agentAlive":"alive"')
    expect(body).not.toContain('"healthy":true')
  })

  it('refuses a mode-000 ledger without marking the snapshot worker done or alive', async () => {
    const home = tempHome()
    writeMeta(home, ['worker-a'])
    const file = join(home, 'state', 'fleet-ledger.jsonl')
    writeLedger(home, ledgerText(MESSY))
    chmodSync(file, 0)
    mount(home, 'ok')
    try {
      const { data } = await getWorkers()
      expect(idsOf(data!)).toEqual(['worker-a'])
      expect(data!.workers[0]?.crewState).toBe('working')
      expect(data!.workers[0]?.endpoint.agentAlive).toBe('unknown')
      expect(data!.observation.status).toBe('failed')
      expect(data!.observation.health).toBe('unknown')
      expect(data!.observation.completion).toBe('unknown')
      expect(data!.observation.notWorkers).toEqual([])
    } finally {
      chmodSync(file, 0o644)
    }
  })
})

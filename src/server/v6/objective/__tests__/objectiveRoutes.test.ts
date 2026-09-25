import { createServer, type Server } from 'node:http'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { T01_PROCESS_UNCLAIMED, type CurrentObjective, type WorkerObjectiveRecord } from '../../../../v6/objective/model'
import type { CommandResult, InboxRunner } from '../inbox'
import { submitIntent } from '../inbox'
import { defaultObjectiveFile, readDocument, registerObjectiveRoutes } from '../index'

interface ApiBody<T> {
  ok: boolean
  data?: T
  error?: { message: string }
}

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(err => err ? reject(err) : resolve())
  })))
})

function listen(server: Server): Promise<number> {
  servers.push(server)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') reject(new Error('no port'))
      else resolve(addr.port)
    })
  })
}

function clock(start = 0): () => string {
  let tick = start
  return () => {
    const second = String(tick).padStart(2, '0')
    tick += 1
    return `2026-09-24T07:20:${second}.000Z`
  }
}

function fakeRunner(): InboxRunner & { calls: Array<{ script: string; args: string[]; env: NodeJS.ProcessEnv }> } {
  const calls: Array<{ script: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  let notes = 0
  return {
    calls,
    async exec(script, args, env): Promise<CommandResult> {
      calls.push({ script, args: [...args], env: { ...env } })
      if (args[0] === 'note') {
        notes += 1
        return {
          code: 0,
          stdout: JSON.stringify({
            schema: 'fm-inbox-note.v1',
            outcome: 'created',
            id: `note-${notes}`,
            request_id: args[2],
            saved: true,
            announced: true,
            acknowledged: false,
          }),
          stderr: '',
        }
      }
      if (args[0] === 'ready') {
        return { code: 0, stdout: JSON.stringify({ schema: 'fm-primary-ready.v1', can_receive: true }), stderr: '' }
      }
      return { code: 1, stdout: '', stderr: `refused subcommand ${String(args[0])}` }
    },
  }
}

function noteCalls(runner: ReturnType<typeof fakeRunner>) {
  return runner.calls.filter(call => call.args[0] === 'note').map(call => ({
    script: call.script,
    args: call.args,
    env: call.env,
    envelope: JSON.parse(call.args[5] ?? '{}') as {
      kind: string
      requestId: string
      body: Record<string, unknown>
      anchor: { type: string; ids: string[] }
    },
  }))
}

async function boot(file: string, runner = fakeRunner(), now = clock()) {
  const server = createServer()
  registerObjectiveRoutes(server, {
    projectionFile: file,
    now,
    home: '/tmp/v6-objective-fm-home',
    binDir: '/tmp/v6-objective-bin',
    runner,
  })
  const port = await listen(server)
  expect(port).not.toBe(5280)
  expect(port).not.toBe(5281)
  return { port, runner }
}

async function send<T>(port: number, path: string, init?: RequestInit): Promise<{ status: number; body: ApiBody<T> }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init)
  const body = await response.json() as ApiBody<T>
  return { status: response.status, body }
}

function post<T>(port: number, path: string, payload: unknown) {
  return send<T>(port, path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

function dataOf<T>(result: { body: ApiBody<T> }): T {
  expect(result.body.ok).toBe(true)
  if (!result.body.data) throw new Error('missing data')
  return result.body.data
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'v6-objective-')), 'objectives.json')
}

describe('T10 objective store', () => {
  it('keeps one current objective per worker, bumps the revision, and reloads both', async () => {
    const file = tempFile()
    const runner = fakeRunner()
    const { port } = await boot(file, runner, clock())

    const first = dataOf(await post<WorkerObjectiveRecord>(port, '/api/v6/objectives/solo', {
      requestId: 'set-solo-1',
      revision: null,
      text: 'stand alone',
      fixture: true,
    }))
    expect(first.current?.text).toBe('stand alone')
    expect(first.current?.revision).toBe('1')
    expect(first.current?.fixture).toBe(true)
    expect(first.current?.pending).toBe(true)
    expect(first.history).toEqual([])

    const replay = dataOf(await post<WorkerObjectiveRecord>(port, '/api/v6/objectives/solo', {
      requestId: 'set-solo-1',
      revision: null,
      text: 'a different sentence',
      fixture: true,
    }))
    expect(replay.current?.text).toBe('stand alone')
    expect(replay.current?.revision).toBe('1')
    expect(noteCalls(runner)).toHaveLength(1)

    const second = dataOf(await post<WorkerObjectiveRecord>(port, '/api/v6/objectives/solo', {
      requestId: 'set-solo-2',
      revision: '1',
      text: 'stand alone, revised',
      fixture: true,
    }))
    expect(second.current?.revision).toBe('2')
    expect(second.current?.text).toBe('stand alone, revised')
    expect(second.history.map(entry => entry.revision)).toEqual(['1'])
    expect(second.history[0]?.text).toBe('stand alone')

    const attached = dataOf(await post<WorkerObjectiveRecord>(port, '/api/v6/objectives/attached', {
      requestId: 'set-attached-1',
      revision: null,
      text: 'attached objective',
      fixture: true,
    }))
    expect(attached.current?.revision).toBe('1')

    const mismatch = await post<WorkerObjectiveRecord>(port, '/api/v6/objectives/solo', {
      requestId: 'set-solo-3',
      revision: null,
      text: 'stale',
      fixture: true,
    })
    expect(mismatch.status).toBe(409)
    expect(mismatch.body.ok).toBe(false)

    const doc = readDocument(file)
    expect(doc.workers.solo?.current?.text).toBe('stand alone, revised')
    expect(doc.workers.solo?.current?.revision).toBe('2')
    expect(doc.workers.solo?.history[0]?.revision).toBe('1')
    expect(doc.workers.attached?.current?.text).toBe('attached objective')
    expect(Object.keys(doc.launches)).toEqual([])

    const again = createServer()
    registerObjectiveRoutes(again, {
      projectionFile: file,
      home: '/tmp/v6-objective-fm-home',
      binDir: '/tmp/v6-objective-bin',
      runner,
    })
    const port2 = await listen(again)
    const reloaded = dataOf(await send<WorkerObjectiveRecord>(port2, '/api/v6/objectives/solo'))
    expect(reloaded.current?.text).toBe('stand alone, revised')
    expect(reloaded.current?.revision).toBe('2')
    expect(reloaded.history[0]?.text).toBe('stand alone')
    expect(noteCalls(runner)).toHaveLength(3)
  })

  it('stores a narrower objective without plan progress or a completed parent task', async () => {
    const root = mkdtempSync(join(tmpdir(), 'v6-objective-narrow-'))
    const file = join(root, 'objectives.json')
    const portfolio = join(root, 'portfolio.json')
    const plan = join(root, 'plan-progress.json')
    writeFileSync(portfolio, '{"completedAt":null,"progress":0}\n')
    writeFileSync(plan, '{"progress":1}\n')
    const runner = fakeRunner()
    const { port } = await boot(file, runner)

    const saved = dataOf(await post<WorkerObjectiveRecord>(port, '/api/v6/objectives/attached', {
      requestId: 'set-narrow-1',
      revision: null,
      text: 'fix the objective panel only',
      narrower: true,
      parentTaskId: 'task-parent',
      planTaskLabel: 'Objective panel',
      planTaskSource: 'plan-task',
      fixture: true,
      completedAt: '2026-09-24T07:20:00.000Z',
      planProgress: 1,
      progress: 1,
    }))
    const current = saved.current as CurrentObjective
    expect(current.narrower).toBe(true)
    expect(current.parentTaskId).toBe('task-parent')
    expect(current.parentTaskCompletedAt).toBeNull()
    expect(current.planProgress).toBeNull()
    expect(current.planTaskLabel).toBe('Objective panel')
    expect(current.planTaskSource).toBe('plan-task')
    expect(current.fixture).toBe(true)

    const note = noteCalls(runner)[0]?.envelope
    expect(note?.kind).toBe('objective.set')
    expect(note?.body).not.toHaveProperty('completedAt')
    expect(note?.body).not.toHaveProperty('planProgress')
    expect(note?.body).not.toHaveProperty('progress')

    const receipt = await post(port, '/api/v6/objectives/receipts', {
      schema: 'tinstar.v6.receipt/1',
      requestId: 'set-narrow-1',
      outcome: 'applied',
      detail: 'objective recorded',
    })
    expect(receipt.body.ok).toBe(true)
    const after = readDocument(file).workers.attached?.current
    expect(after?.disposition).toBe('applied')
    expect(after?.pending).toBe(false)
    expect(after?.text).toBe('fix the objective panel only')
    expect(after?.parentTaskCompletedAt).toBeNull()
    expect(after?.planProgress).toBeNull()
    expect(JSON.stringify(readDocument(file))).not.toContain('"completedAt"')
    expect(readFileSync(portfolio, 'utf8')).toBe('{"completedAt":null,"progress":0}\n')
    expect(readFileSync(plan, 'utf8')).toBe('{"progress":1}\n')
  })

  it('rejects an unknown plan-task source instead of coercing it', async () => {
    const file = tempFile()
    const runner = fakeRunner()
    const { port } = await boot(file, runner)
    const response = await post(port, '/api/v6/objectives/solo', {
      requestId: 'set-bad-source',
      revision: null,
      text: 'hello',
      planTaskLabel: 'Something',
      planTaskSource: 'acceptance',
      fixture: true,
    })
    expect(response.status).toBe(400)
    expect(noteCalls(runner)).toHaveLength(0)
    expect(readDocument(file).workers.solo).toBeUndefined()
  })
})

describe('T10 achieve your objective', () => {
  it('submits one thread.message through submitIntent and does not type into tmux', async () => {
    const file = tempFile()
    const runner = fakeRunner()
    const previousTmux = process.env.TMUX
    const previousHome = process.env.FM_HOME
    process.env.TMUX = '/tmp/live-tmux,123,0'
    process.env.FM_HOME = '/tmp/live-firstmate-home'
    try {
      const { port } = await boot(file, runner)
      await post(port, '/api/v6/objectives/solo', {
        requestId: 'set-achieve-1',
        revision: null,
        text: 'hold the line',
        fixture: true,
      })
      const achieved = dataOf(await post<{ achievement: { text: string; workerId: string; pending: boolean; requestId: string } }>(
        port,
        '/api/v6/objectives/solo/achieve',
        { requestId: 'achieve-1', revision: '1' },
      ))
      expect(achieved.achievement.text).toBe('hold the line')
      expect(achieved.achievement.workerId).toBe('solo')
      expect(achieved.achievement.pending).toBe(true)

      const again = dataOf(await post<{ achievement: { requestId: string } }>(
        port,
        '/api/v6/objectives/solo/achieve',
        { requestId: 'achieve-1', revision: '1' },
      ))
      expect(again.achievement.requestId).toBe('achieve-1')

      const notes = noteCalls(runner)
      const thread = notes.filter(note => note.envelope.kind === 'thread.message')
      expect(thread).toHaveLength(1)
      expect(thread[0]?.script).toBe('/tmp/v6-objective-bin/fm-inbox.sh')
      expect(thread[0]?.args.slice(0, 5)).toEqual(['note', '--request-id', 'achieve-1', '--json', '--'])
      expect(thread[0]?.envelope.body.workerId).toBe('solo')
      expect(thread[0]?.envelope.body.text).toBe('hold the line')
      expect(thread[0]?.envelope.anchor).toEqual({ type: 'worker', ids: ['solo'] })
      expect(thread[0]?.env.FM_HOME).toBe('/tmp/v6-objective-fm-home')
      expect(thread[0]?.env.TMUX).toBeUndefined()
      expect(runner.calls.every(call => call.args[0] === 'note' || call.args[0] === 'ready')).toBe(true)
      expect(readDocument(file).workers.solo?.current?.text).toBe('hold the line')
      expect(readDocument(file).workers.solo?.current?.parentTaskCompletedAt).toBeNull()
      expect(readDocument(file).workers.solo?.current?.planProgress).toBeNull()
    } finally {
      if (previousTmux === undefined) delete process.env.TMUX
      else process.env.TMUX = previousTmux
      if (previousHome === undefined) delete process.env.FM_HOME
      else process.env.FM_HOME = previousHome
    }
  })

  it('does not submit when the worker has no objective', async () => {
    const file = tempFile()
    const runner = fakeRunner()
    const { port } = await boot(file, runner)
    const response = await post(port, '/api/v6/objectives/solo/achieve', { requestId: 'achieve-none', revision: null })
    expect(response.status).toBe(409)
    expect(noteCalls(runner)).toHaveLength(0)
  })
})

describe('T01 launch intent', () => {
  it('stores one pending launch for a request id and does not claim a process', async () => {
    const file = tempFile()
    const runner = fakeRunner()
    const { port } = await boot(file, runner)
    const payload = {
      requestId: 'launch-1',
      project: 'tinstar',
      objective: 'ship the objective panel',
      sessionName: 'tinstar-worker',
      fixture: true,
      initiativeId: 'should-not-stick',
      epicId: 'should-not-stick',
    }
    const first = dataOf(await post<{
      requestId: string
      status: string
      processCreated: boolean
      pending: boolean
      processClaim: string
      objective: string
      project: string
      sessionName: string | null
      fixture: boolean
    }>(port, '/api/v6/launches', payload))
    expect(first.status).toBe('pending')
    expect(first.pending).toBe(true)
    expect(first.processCreated).toBe(false)
    expect(first.processClaim).toBe(T01_PROCESS_UNCLAIMED)
    expect(first.fixture).toBe(true)
    expect(first.sessionName).toBe('tinstar-worker')

    const second = dataOf(await post<typeof first>(port, '/api/v6/launches', {
      ...payload,
      objective: 'a second objective that must not create a row',
    }))
    expect(second).toEqual(first)

    const notes = noteCalls(runner)
    expect(notes).toHaveLength(1)
    expect(notes[0]?.envelope.kind).toBe('launch.request')
    expect(notes[0]?.envelope.body.project).toBe('tinstar')
    expect(notes[0]?.envelope.body.objective).toBe('ship the objective panel')
    expect(notes[0]?.envelope.body).not.toHaveProperty('initiativeId')
    expect(notes[0]?.envelope.body).not.toHaveProperty('epicId')
    expect(runner.calls.every(call => call.args[0] === 'note' || call.args[0] === 'ready')).toBe(true)

    const doc = readDocument(file)
    expect(Object.keys(doc.launches)).toEqual(['launch-1'])
    expect(JSON.stringify(doc)).not.toContain('initiativeId')
    expect(JSON.stringify(doc)).not.toContain('epicId')
    expect(doc.launches['launch-1']?.processCreated).toBe(false)
    expect(doc.workers).toEqual({})

    const listed = dataOf(await send<{ launches: Array<{ requestId: string }> }>(port, '/api/v6/launches'))
    expect(listed.launches.map(row => row.requestId)).toEqual(['launch-1'])
  })

  it('refuses a live session name and a missing content type', async () => {
    const file = tempFile()
    const runner = fakeRunner()
    const { port } = await boot(file, runner)
    const refused = await post(port, '/api/v6/launches', {
      requestId: 'launch-bad',
      project: 'tinstar',
      objective: 'nope',
      sessionName: 'firstmate',
      fixture: true,
    })
    expect(refused.status).toBe(403)
    expect(noteCalls(runner)).toHaveLength(0)

    const bare = await send(port, '/api/v6/launches', {
      method: 'POST',
      body: JSON.stringify({ requestId: 'launch-2', project: 'tinstar', objective: 'x' }),
    })
    expect(bare.status).toBe(400)
    expect(Object.keys(readDocument(file).launches)).toEqual([])
  })
})

describe('objective inbox guard', () => {
  it('does not exec when the home is unset or the body carries a command', async () => {
    const previous = {
      home: process.env.TINSTAR_V6_FM_HOME,
      bin: process.env.FM_V6_BIN,
      alt: process.env.TINSTAR_V6_FM_BIN,
    }
    delete process.env.TINSTAR_V6_FM_HOME
    delete process.env.FM_V6_BIN
    delete process.env.TINSTAR_V6_FM_BIN
    const runner = fakeRunner()
    try {
      const unconfigured = await submitIntent({
        schema: 'tinstar.v6.intent/1',
        kind: 'thread.message',
        requestId: 'req-plain',
        revision: null,
        anchor: { type: 'worker', ids: ['solo'] },
        body: { workerId: 'solo', text: 'hello' },
      }, { runner })
      expect(unconfigured.disposition).toBe('failed')
      expect(unconfigured.applied).toBe(false)
      expect(runner.calls).toHaveLength(0)

      const commanded = await submitIntent({
        schema: 'tinstar.v6.intent/1',
        kind: 'launch.request',
        requestId: 'req-cmd',
        revision: null,
        anchor: { type: 'selection', ids: ['tinstar'] },
        body: { project: 'tinstar', objective: 'x', command: 'echo hi' },
      }, { home: '/tmp/v6-objective-fm-home', binDir: '/tmp/v6-objective-bin', runner })
      expect(commanded.disposition).toBe('failed')
      expect(runner.calls).toHaveLength(0)
    } finally {
      if (previous.home === undefined) delete process.env.TINSTAR_V6_FM_HOME
      else process.env.TINSTAR_V6_FM_HOME = previous.home
      if (previous.bin === undefined) delete process.env.FM_V6_BIN
      else process.env.FM_V6_BIN = previous.bin
      if (previous.alt === undefined) delete process.env.TINSTAR_V6_FM_BIN
      else process.env.TINSTAR_V6_FM_BIN = previous.alt
    }
  })

  it('keeps the projection under getConfigRoot and leaves a bad file untouched', async () => {
    expect(process.env.TINSTAR_CONFIG_HOME).toBeTruthy()
    expect(defaultObjectiveFile()).toBe(join(process.env.TINSTAR_CONFIG_HOME as string, 'v6', 'objectives.json'))
    const file = tempFile()
    writeFileSync(file, '{"schema":"nope"}\n')
    const { port } = await boot(file)
    const response = await post(port, '/api/v6/objectives/solo', {
      requestId: 'set-corrupt',
      revision: null,
      text: 'should not replace the file',
      fixture: true,
    })
    expect(response.body.ok).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{"schema":"nope"}\n')
  })

  it('does not name a forbidden command in the objective implementation', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const roots = [join(here, '..'), join(here, '../../../../v6/objective')]
    const banned = ['fm-spawn', 'fm-send', 'fm-control', 'fm-teardown', 'send-keys', '8932']
    const files: string[] = []
    function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        if (name === '__tests__') continue
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (name.endsWith('.ts') || name.endsWith('.tsx')) files.push(path)
      }
    }
    for (const root of roots) walk(root)
    expect(files.length).toBeGreaterThan(0)
    const source = files.map(path => readFileSync(path, 'utf8')).join('\n')
    for (const word of banned) expect(source).not.toContain(word)
  })
})

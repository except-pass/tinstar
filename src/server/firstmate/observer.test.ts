import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentStore } from '../stores/document-store'
import { getSession } from '../sessions/session'
import { FIRSTMATE_VIEW, FirstmateObserver, isObservedRun, observedRunId, type FirstmateCardData } from './observer'
import { LEDGER_FILE } from './ledger-watcher'
import type { Run } from '../../domain/types'

const j = (o: Record<string, unknown>) => JSON.stringify({ v: 1, ...o }) + '\n'
const dispatched = (task: string, ts: number, extra: Record<string, unknown> = {}) =>
  j({ ts, event: 'task.dispatched', task, kind: 'ship', project: 'webapp', harness: 'claude', model: 'm1', ...extra })
const status = (task: string, ts: number, state: string, text: string, key: string | null = null) =>
  j({ ts, event: 'task.status', task, state, key, text })

/** Every file under `dir` with its size, mtime and contents — a full fingerprint. */
function fingerprint(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name)
      const s = statSync(p)
      if (s.isDirectory()) { out.push(`${p}/`); walk(p) }
      else out.push(`${p}|${s.size}|${s.mtimeMs}|${readFileSync(p, 'utf8')}`)
    }
  }
  walk(dir)
  return out
}

describe('FirstmateObserver', () => {
  let home: string
  let configRoot: string
  let store: DocumentStore
  let observers: FirstmateObserver[]
  let sessionNames: Set<string>
  const ledger = () => join(home, 'state', LEDGER_FILE)
  const card = (id: string) => (store.getRun(id)?.viewData as { firstmate: FirstmateCardData } | undefined)?.firstmate

  function make(opts: { homes?: string[]; projectDir?: string; transcriptPollMs?: number } = {}): FirstmateObserver {
    const o = new FirstmateObserver({
      homes: opts.homes ?? [home],
      docStore: store,
      configRoot,
      hasSession: n => sessionNames.has(n),
      pollMs: 20,
      transcriptPollMs: opts.transcriptPollMs ?? 0,
      projectDirFor: opts.projectDir ? () => opts.projectDir : undefined,
    })
    observers.push(o)
    return o
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fm-home-'))
    configRoot = mkdtempSync(join(tmpdir(), 'fm-cfg-'))
    mkdirSync(join(home, 'state'))
    store = new DocumentStore()
    store.activeSpaceId = 'space-1'
    observers = []
    sessionNames = new Set()
  })
  afterEach(() => {
    for (const o of observers) o.stop()
    rmSync(home, { recursive: true, force: true })
    rmSync(configRoot, { recursive: true, force: true })
  })

  it('mirrors a worker as a docstore-only Run under Project → Worktree', async () => {
    writeFileSync(join(home, 'state', 'fix-login.meta'), 'window=firstmate:fm-fix-login\nworktree=/wt/1/webapp\n')
    writeFileSync(ledger(),
      dispatched('fix-login', 10)
      + status('fix-login', 20, 'working', ' reproducing')
      + j({ ts: 30, event: 'task.pr_ready', task: 'fix-login', pr: 'https://github.com/acme/webapp/pull/7' }))
    await make().start()

    const run = store.getRun('fm--fix-login')!
    expect(run).toMatchObject({
      id: 'fm--fix-login', name: 'fix-login', sessionId: 'fm--fix-login', status: 'running',
      backend: null, port: null, view: FIRSTMATE_VIEW, spaceId: 'space-1',
      scope: { project: 'webapp', worktree: 'fix-login' },
    })
    expect(run.attention).toBeUndefined()
    expect(card('fm--fix-login')).toMatchObject({
      task: 'fix-login', kind: 'ship', project: 'webapp', harness: 'claude', model: 'm1',
      status: 'working', statusText: 'reproducing', pr: 'https://github.com/acme/webapp/pull/7',
      merged: null, worktree: '/wt/1/webapp', decisions: [],
    })
  })

  it('works without any meta file and for a task with no dispatched record', async () => {
    writeFileSync(ledger(), status('orphan', 5, 'working', ' hi'))
    await make().start()
    expect(card('fm--orphan')).toMatchObject({ task: 'orphan', kind: null, worktree: null, project: null })
    expect(store.getRun('fm--orphan')!.scope).toBeUndefined()
  })

  it('raises urgent Inbox attention for needs-decision / blocked / failed only', async () => {
    writeFileSync(ledger(),
      dispatched('a', 1) + status('a', 2, 'needs-decision', ' pick A or B', 'k1')
      + dispatched('b', 1) + status('b', 2, 'blocked', ' no creds')
      + dispatched('c', 1) + status('c', 2, 'failed', ' boom')
      + dispatched('d', 1) + status('d', 2, 'done', ' shipped')
      + dispatched('e', 1) + status('e', 2, 'working', ' going')
      + dispatched('f', 1) + status('f', 2, 'paused', ' waiting'))
    await make().start()
    for (const t of ['a', 'b', 'c']) {
      const r = store.getRun(`fm--${t}`)!
      expect(r.status).toBe('needs_attention')
      expect(r.attention).toMatchObject({ level: 'urgent' })
    }
    expect(store.getRun('fm--a')!.attention!.reason).toBe('needs-decision: pick A or B')
    expect(card('fm--a')!.decisions).toHaveLength(1)
    for (const t of ['d', 'e', 'f']) expect(store.getRun(`fm--${t}`)!.attention).toBeUndefined()
    expect(store.getRun('fm--d')!.status).toBe('idle')
  })

  it('clears attention when the decision is resolved and the worker moves on', async () => {
    writeFileSync(ledger(), dispatched('a', 1) + status('a', 2, 'needs-decision', ' q', 'k'))
    const o = make()
    await o.start()
    expect(store.getRun('fm--a')!.attention).toBeDefined()
    appendFileSync(ledger(), status('a', 3, 'resolved', ' answered', 'k') + status('a', 4, 'working', ' continuing'))
    await waitFor(() => store.getRun('fm--a')!.status === 'running')
    expect(store.getRun('fm--a')!.attention).toBeUndefined()
    expect(card('fm--a')!.decisions).toEqual([])
  })

  it('shows merged workers as idle and removes cards on cleaned_up', async () => {
    writeFileSync(ledger(), dispatched('a', 1)
      + j({ ts: 5, event: 'task.merged', task: 'a', via: 'pr', pr: 'https://github.com/o/r/pull/1' }))
    const o = make()
    await o.start()
    expect(store.getRun('fm--a')!.status).toBe('idle')
    expect(card('fm--a')!.merged).toEqual({ via: 'pr', pr: 'https://github.com/o/r/pull/1' })
    appendFileSync(ledger(), j({ ts: 9, event: 'task.cleaned_up', task: 'a' }))
    await waitFor(() => !store.getRun('fm--a'))
  })

  it('does not re-emit a run change when a re-read finds nothing new', async () => {
    writeFileSync(ledger(), dispatched('a', 1) + status('a', 2, 'working', ' x'))
    const o = make()
    await o.start()
    let runChanges = 0
    store.changes.on('change', (c: { entity: string }) => { if (c.entity === 'run') runChanges++ })
    // duplicate records + several poll ticks
    appendFileSync(ledger(), dispatched('a', 1) + status('a', 2, 'working', ' x'))
    await new Promise(r => setTimeout(r, 120))
    expect(runChanges).toBe(0)
  })

  it('rebuilds after the ledger is truncated, dropping workers that are gone', async () => {
    writeFileSync(ledger(), dispatched('a', 1) + dispatched('b', 1))
    const o = make()
    await o.start()
    expect(store.getRun('fm--a')).toBeDefined()
    writeFileSync(ledger(), dispatched('b', 50))
    await waitFor(() => !store.getRun('fm--a'))
    expect(store.getRun('fm--b')).toBeDefined()
  })

  it('prunes persisted observed runs that no ledger backs, at start', async () => {
    store.upsertRun('fm--ghost', { ...baseRun('fm--ghost'), view: FIRSTMATE_VIEW })
    writeFileSync(ledger(), dispatched('a', 1))
    await make().start()
    expect(store.getRun('fm--ghost')).toBeUndefined()
    expect(store.getRun('fm--a')).toBeDefined()
  })

  describe('dismiss', () => {
    it('a UI delete is remembered: later ledger lines do not resurrect the card', async () => {
      writeFileSync(ledger(), dispatched('a', 100) + status('a', 101, 'working', ' x'))
      const o = make()
      await o.start()
      store.deleteRun('fm--a') // what DELETE /api/sessions/:name's docstore-only branch does
      appendFileSync(ledger(), status('a', 102, 'working', ' still going'))
      await new Promise(r => setTimeout(r, 120))
      expect(store.getRun('fm--a')).toBeUndefined()
      expect(JSON.parse(readFileSync(join(configRoot, 'firstmate', 'dismissed.json'), 'utf8'))).toHaveProperty(['fm--a'])
    })

    it('survives a restart, but a genuinely newer dispatch of the same task shows again', async () => {
      writeFileSync(ledger(), dispatched('a', 100))
      const first = make()
      await first.start()
      store.deleteRun('fm--a')
      first.stop()

      const second = make()
      await second.start()
      expect(store.getRun('fm--a')).toBeUndefined()

      const future = Math.floor(Date.now() / 1000) + 1000
      appendFileSync(ledger(), dispatched('a', future))
      await waitFor(() => !!store.getRun('fm--a'))
    })

    it("the observer's own removals are not recorded as dismissals", async () => {
      writeFileSync(ledger(), dispatched('a', 1))
      const o = make()
      await o.start()
      appendFileSync(ledger(), j({ ts: 2, event: 'task.cleaned_up', task: 'a' }))
      await waitFor(() => !store.getRun('fm--a'))
      expect(existsSync(join(configRoot, 'firstmate', 'dismissed.json'))).toBe(false)
    })
  })

  describe('collision guards', () => {
    it('skips a task whose name is already a real Tinstar session', async () => {
      sessionNames.add('fm--a')
      writeFileSync(ledger(), dispatched('a', 1) + dispatched('b', 1))
      await make().start()
      expect(store.getRun('fm--a')).toBeUndefined()
      expect(store.getRun('fm--b')).toBeDefined()
    })

    it('never overwrites a run it does not own', async () => {
      const own = { ...baseRun('fm--a'), backend: 'tmux' as const, name: 'mine' }
      store.upsertRun('fm--a', own)
      writeFileSync(ledger(), dispatched('a', 1))
      await make().start()
      expect(store.getRun('fm--a')).toEqual(own)
      expect(isObservedRun(store.getRun('fm--a')!)).toBe(false)
    })

    it('prefixes ids with a home tag when several homes are configured', async () => {
      const home2 = mkdtempSync(join(tmpdir(), 'fm-home2-'))
      try {
        mkdirSync(join(home2, 'state'))
        writeFileSync(ledger(), dispatched('same', 1))
        writeFileSync(join(home2, 'state', LEDGER_FILE), dispatched('same', 1))
        await make({ homes: [home, home2] }).start()
        const ids = store.getAllRuns().map(r => r.id)
        expect(ids).toHaveLength(2)
        expect(new Set(ids).size).toBe(2)
        for (const id of ids) expect(id).toMatch(/^fm-[0-9a-f]{6}-same$/)
      } finally { rmSync(home2, { recursive: true, force: true }) }
    })
  })

  // ---- The hard invariant: observed workers are never Tinstar-owned sessions. ----
  describe('invariant: observed workers are never Tinstar-owned sessions', () => {
    it('creates no session record, sessions dir, or tinstar-* identity, and never writes to the first mate home', async () => {
      writeFileSync(join(home, 'state', 'fix.meta'), 'window=firstmate:fm-fix\nworktree=/wt/1/webapp\n')
      writeFileSync(ledger(), dispatched('fix', 1) + status('fix', 2, 'blocked', ' x') + dispatched('other', 3))
      const before = fingerprint(home)

      const o = make()
      await o.start()
      appendFileSync(ledger(), status('other', 4, 'working', ' y')) // the ledger is the FIRST MATE's write, not ours
      await waitFor(() => card('fm--other')?.status === 'working')
      const afterAppend = fingerprint(home)
      o.stop()

      // 1. Nothing in the home changed except the append the test itself made.
      const expected = before.map(e => e.startsWith(ledger()) ? afterAppend.find(a => a.startsWith(ledger()))! : e)
      expect(afterAppend).toEqual(expected)
      expect(readdirSync(join(home, 'state')).sort()).toEqual(['fix.meta', LEDGER_FILE].sort())

      // 2. No Tinstar session store exists, so no session lifecycle path can find these.
      expect(existsSync(join(configRoot, 'sessions'))).toBe(false)
      for (const run of store.getAllRuns()) {
        expect(getSession(join(configRoot, 'sessions'), run.id)).toBeNull()
        expect(getSession(join(configRoot, 'sessions'), run.name ?? '')).toBeNull()
        // 3. Docstore-only shape: no backend, no ttyd port, not a tinstar-* / tmux name.
        expect(run.backend).toBeNull()
        expect(run.port).toBeNull()
        expect(run.id.startsWith('fm-')).toBe(true)
        expect(run.id.startsWith('tinstar-')).toBe(false)
        expect(run.sessionId).toBe(run.id)
      }
      // 4. Only Tinstar's own config root was written, and only the dismissal file may live there.
      expect(readdirSync(configRoot).filter(n => n !== 'firstmate')).toEqual([])
    })

    it('the observed run id is not a tmux-session-shaped name', () => {
      expect(observedRunId('t', null)).toBe('fm--t')
      expect(observedRunId('t', 'abc123')).toBe('fm-abc123-t')
    })
  })
  describe('conversation link (M3)', () => {
    const iso = (sec: number) => new Date(sec * 1000).toISOString()
    const CONV = 'a599bd80-0000-4000-8000-000000000001'
    let projectDir: string

    function writeConv(id: string, records: object[]) {
      const first = { type: 'user', cwd: '/wt/1/webapp', isSidechain: false, entrypoint: 'claude-desktop', timestamp: iso(1000), message: { content: 'go' } }
      writeFileSync(join(projectDir, `${id}.jsonl`), [first, ...records].map(r => JSON.stringify(r)).join('\n') + '\n')
    }
    const assistant = (text: string, toolUse = false) => ({
      type: 'assistant', timestamp: iso(1001),
      message: { content: toolUse ? [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] : [{ type: 'text', text }] },
    })

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), 'fm-proj-'))
      writeFileSync(join(home, 'state', 't1.meta'), 'worktree=/wt/1/webapp\nspawn_gen=s1000\n')
      writeFileSync(ledger(), dispatched('t1', 1005))
    })
    afterEach(() => rmSync(projectDir, { recursive: true, force: true }))

    it('links the conversation and shows running/idle from the transcript tail', async () => {
      writeConv(CONV, [assistant('', true)])
      const o = make({ projectDir })
      await o.start()
      expect(card('fm--t1')).toMatchObject({ conversationId: CONV, conversationSource: 'auto', activity: 'running', runId: 'fm--t1' })
      expect(o.resolveTranscript('fm--t1')).toMatchObject({ conversationId: CONV, path: join(projectDir, `${CONV}.jsonl`) })
    })

    it('flips to idle on a later poll without any new ledger line, and feeds recap entries', async () => {
      writeConv(CONV, [assistant('', true)])
      const o = make({ projectDir, transcriptPollMs: 20 })
      await o.start()
      expect(card('fm--t1')!.activity).toBe('running')
      appendFileSync(join(projectDir, `${CONV}.jsonl`), JSON.stringify(assistant('all done')) + '\n')
      await waitFor(() => card('fm--t1')!.activity === 'idle')
      expect(store.getRun('fm--t1')!.recapEntries.length).toBeGreaterThan(0)
    })

    it('never writes into the transcript dir or the first mate home', async () => {
      writeConv(CONV, [assistant('done')])
      const before = [...fingerprint(home), ...fingerprint(projectDir)]
      const o = make({ projectDir })
      await o.start()
      o.stop()
      expect([...fingerprint(home), ...fingerprint(projectDir)]).toEqual(before)
    })

    it('leaves the card unlinked when no transcript matches', async () => {
      const o = make({ projectDir })
      await o.start()
      expect(card('fm--t1')).toMatchObject({ conversationId: null, activity: null })
      expect(o.resolveTranscript('fm--t1')).toBeNull()
    })

    it('manual override re-links and persists; null returns to the heuristic', async () => {
      const OTHER = 'b0000000-0000-4000-8000-000000000002'
      writeConv(CONV, [assistant('done')])
      writeConv(OTHER, [assistant('', true)])
      const o = make({ projectDir })
      await o.start()
      expect(await o.setConversationOverride('fm--t1', OTHER)).toBe(true)
      expect(card('fm--t1')).toMatchObject({ conversationId: OTHER, conversationSource: 'manual', activity: 'running' })
      expect(JSON.parse(readFileSync(join(configRoot, 'firstmate', 'conversation-overrides.json'), 'utf8'))).toEqual({ 'fm--t1': OTHER })
      expect(await o.setConversationOverride('fm--t1', '../bad')).toBe(false)
      expect(await o.setConversationOverride('fm--nope', OTHER)).toBe(false)
      expect(await o.setConversationOverride('fm--t1', null)).toBe(true)
      expect(card('fm--t1')!.conversationSource).toBe('auto')
    })
  })
})

function baseRun(id: string): Run {
  return {
    id, status: 'idle', background: false, blocked: false, sessionId: id, taskId: '', initiative: '', epic: '',
    task: '', repo: '', worktree: '', touchedFiles: [], recapEntries: [], rawLogs: '', port: null, backend: null,
    worktreeId: '', createdAt: new Date(0).toISOString(),
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 15))
  }
}

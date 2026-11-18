import { deepEqual, equal, match, ok, rejects, throws } from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { encode } from '@toon-format/toon'
import { entityId, observe, parseTasks, parseWorkers, sourcesFor } from '../firstmate.js'
import { Journal } from '../journal.js'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../events', import.meta.url))
const at = minutes => new Date(Date.UTC(2026, 0, 2, 12, minutes)).toISOString()
const home = { id: 'example:west', path: '/example/west', mode: 'fixture' }
const [tasks, workers] = sourcesFor(home)

async function temp(t) {
  const directory = await mkdtemp(join(tmpdir(), 'event-publisher-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

function row(id, fields = {}) {
  return {
    id, state: 'queued', kind: 'ship', repo: 'example-repo', title: 'Synthetic work',
    blocked: 'no', held: 'no', hold_reason: '-', hold_kind: '-', hold_until: '-', created: '2026-01-01',
    closed: '-', deps: 'none', links: 'none', priority: '-', ...fields,
  }
}

function taskObservation(rows, minute, source = tasks) {
  const text = encode({ count: rows.length, tasks: rows })
  return {
    source, started_at: at(minute), observed_at: at(minute + 1), health: 'ok',
    entries: parseTasks(text, source.home_id),
  }
}

function workerObservation(samples, minute) {
  const generated = at(minute)
  const text = encodeFleet(generated, samples)
  const payload = parseWorkers(text, home, generated, at(minute + 1))
  return {
    source: workers, started_at: generated, observed_at: at(minute + 1),
    health: payload.counts.current_state_unavailable > 0 ? 'partial' : 'ok',
    ...payload,
  }
}

function encodeFleet(generated, samples) {
  return JSON.stringify({
    schema: 'fm-fleet-snapshot.v1', fm_home: home.path, generated,
    main_inventory: { valid: true },
    secondmate_current: { registry: { present: false } },
    tasks: samples.map(({ id, gen, state, source = 'pane', last = 'paused' }) => ({
      id, spawn_gen: gen, remote: null,
      current_state: { state, source, observed_at: generated, freshness: 'fresh', detail: 'synthetic sensitive details' },
      paths: { status_log: { last_event: { state: last, raw: 'synthetic private text' } } },
    })),
  })
}

test('home binding survives restart and is shared by task and worker sources', async t => {
  const path = await temp(t)
  const db = join(path, 'journal.sqlite')
  const baseline = new Journal(db)
  baseline.register(tasks)
  baseline.record(taskObservation([row('sample-a')], 0))
  baseline.close()

  const journal = new Journal(db)
  t.after(() => journal.close())
  const rebound = { ...home, path: join(path, 'different-home') }
  throws(() => journal.register(sourcesFor(rebound)[1]), /already bound/)

  const config = join(path, 'config.json')
  await writeFile(config, JSON.stringify({ homes: [rebound] }))
  for (const command of ['serve', 'observe']) {
    await rejects(exec(cli, [command, '--config', config, '--db', db]),
      error => error.code === 1 && /already bound/.test(error.stderr))
  }
  journal.register(tasks)
  journal.register(workers)
  equal(journal.tail(), 0)
})

test('CLI rejects oversized intervals and JSON source health output', async () => {
  for (const interval of ['3601', '2147484']) {
    await rejects(exec(cli, ['serve', '--interval', interval]),
      error => error.code === 2 && /--interval must be at most 3600/.test(error.stderr))
  }
  await rejects(exec(cli, ['sources', '--json']),
    error => error.code === 2 && /--json is unsupported for sources/.test(error.stderr))
})

test('baseline, direct Queued to Done, exact task fields, dedup and immutable restart replay', async t => {
  const path = join(await temp(t), 'journal.sqlite')
  const before = row('sample-a', { title: 'one, "two"', priority: 2 })
  const after = row('sample-a', {
    state: 'done', priority: 1, closed: '2026-01-02',
    links: 'pr:https://demo:discard-this@github.com/example/repo/pull/12?token=discard-this#discard-this',
  })
  const baseline = new Journal(path)
  baseline.register(tasks)
  equal(baseline.record(taskObservation([before], 0)), 0)
  baseline.close()

  // The source changed while the collector was stopped.
  const journal = new Journal(path)
  const updated = taskObservation([after], 2)
  equal(journal.record(updated), 5)
  equal(journal.record(updated), 0)
  equal(journal.record(taskObservation([after], 3)), 0)
  const events = journal.events()
  const state = events[0]
  deepEqual(events.map(event => event.change.field), ['state', 'closed', 'pull_requests', 'priority', 'ready'])
  deepEqual(state.change, { field: 'state', before: 'queued', after: 'done' })
  equal(state.occurred_at, null)
  deepEqual(state.observation.observed_between, { after: at(0), by: at(3) })
  equal(new Set(events.map(event => event.observation.batch_id)).size, 1)
  equal(events[2].change.after[0], 'https://github.com/example/repo/pull/12')
  ok(!JSON.stringify(events).includes('discard-this'))
  journal.close()

  const restart = new Journal(path)
  equal(restart.record(taskObservation([after], 4)), 0)
  deepEqual(restart.events({ after: 1 }), events.slice(1))
  deepEqual(restart.inspect(state.event_id), state)
  restart.close()
  const { stdout } = await exec(process.execPath, [cli, 'replay', '--db', path, '--after', '1', '--json'])
  deepEqual(stdout.trim().split('\n').map(JSON.parse), events.slice(1))
})

test('journal rolls back events and watermark if writing fails after the first append', async t => {
  const path = join(await temp(t), 'journal.sqlite')
  const journal = new Journal(path)
  journal.register(tasks)
  journal.record(taskObservation([row('sample-a')], 0))
  const before = journal.sources()
  const inject = new DatabaseSync(path)
  inject.exec(`
    CREATE TRIGGER fault BEFORE INSERT ON events
    WHEN (SELECT count(*) FROM events) = 1
    BEGIN SELECT RAISE(ABORT, 'synthetic journal failure'); END;
  `)
  const updated = taskObservation([row('sample-a', { state: 'done' })], 2)
  throws(() => journal.record(updated), /synthetic journal failure/)
  deepEqual(journal.sources(), before)
  equal(journal.tail(), 0)
  journal.close()
  inject.exec('DROP TRIGGER fault')
  inject.close()

  const restarted = new Journal(path)
  equal(restarted.record(updated), 2)
  deepEqual(restarted.events().map(event => event.sequence), [1, 2])
  restarted.close()
})

test('missing, failed, partial and out-of-order task polls preserve the last witnessed state', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  const moved = sourcesFor({ ...home, id: 'example:east' })[0]
  journal.register(tasks)
  journal.register(moved)
  journal.record(taskObservation([row('sample-a')], 0))
  journal.record(taskObservation([], 0, moved))
  const cursor = journal.sources().find(source => source.source_id === tasks.source_id).last_snapshot_id

  journal.record({ source: tasks, started_at: at(1), observed_at: at(2), health: 'unavailable', reason: 'synthetic outage' })
  journal.record({ source: tasks, started_at: at(2), observed_at: at(3), health: 'partial', reason: 'synthetic truncation' })
  equal(journal.sources().find(source => source.source_id === tasks.source_id).last_snapshot_id, cursor)
  equal(journal.record(taskObservation([row('sample-a', { state: 'done' })], 1)), 0)
  equal(journal.record(taskObservation([], 3)), 0)
  equal(journal.record(taskObservation([row('sample-a')], 3, moved)), 1)
  equal(journal.events()[0].subject.id, entityId('task', moved.home_id, 'sample-a'))
  equal(journal.events()[0].event_type, 'task.observed')
  equal(journal.record(taskObservation([row('sample-a', { state: 'done' })], 4)), 2)
  equal(journal.events()[1].change.before, 'queued')
  throws(() => parseTasks(encode({ count: '1 of 2 total', tasks: [row('sample-a')] }), home.id), /incomplete/)
})

test('worker reconciliation preserves provenance and keeps incarnations separate', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.register(tasks)
  journal.register(workers)
  journal.record(taskObservation([row('sample-worker')], 0))
  const sample = { id: 'sample-worker', gen: 'gen-1', last: 'paused' }
  journal.record(workerObservation([{ ...sample, state: 'parked' }], 0))
  equal(journal.record(workerObservation([{ ...sample, state: 'done', source: 'status-log' }], 1)), 0)
  equal(journal.record(workerObservation([{ ...sample, state: 'working' }], 2)), 1)
  const [changed] = journal.events()
  deepEqual(changed.change, { field: 'current_state', before: 'parked', after: 'working' })
  equal(changed.evidence.state_source, 'pane')
  equal(changed.evidence.historical_last_event, 'paused')
  equal(changed.evidence.source_reference.spawn_gen, 'gen-1')
  deepEqual(changed.related, [{ relation: 'executes', subject: { id: entityId('task', home.id, sample.id), type: 'task' } }])
  equal(changed.observation.observed_between.after, at(0))
  ok(!JSON.stringify(changed).includes('synthetic private'))
  ok(!JSON.stringify(changed).includes('synthetic sensitive'))
  equal(journal.record(workerObservation([{ ...sample, gen: 'gen-2', state: 'unknown' }], 3)), 0)
  equal(journal.record(workerObservation([{ ...sample, gen: 'gen-2', state: 'working' }], 4)), 1)
  equal(journal.record(workerObservation([{ ...sample, gen: 'gen-3', state: 'working' }], 5)), 1)
  const [, previouslyUnknown, newlySeen] = journal.events()
  for (const event of [previouslyUnknown, newlySeen]) {
    equal(event.event_type, 'worker.observed')
    deepEqual(event.change, { after: { current_state: 'working' } })
  }
  equal(previouslyUnknown.subject.id, entityId('worker', home.id, sample.id, 'gen-2'))
  equal(previouslyUnknown.evidence.confidence_basis, 'first verified state for a previously seen incarnation')
  equal(newlySeen.evidence.confidence_basis, 'first seen after the initial inventory')
  throws(() => parseWorkers(encodeFleet(at(0), [sample]), home, at(1), at(2)), /outside this collection window/)
})

test('a worker with unknown state does not hold back another verified worker transition', async t => {
  const path = join(await temp(t), 'journal.sqlite')
  const journal = new Journal(path)
  t.after(() => journal.close())
  journal.register(workers)
  const active = { id: 'active-example', gen: 'gen-1', state: 'working' }
  const unknown = { id: 'unknown-example', gen: 'gen-2', state: 'failed', source: 'status-log' }
  equal(journal.record(workerObservation([active, unknown], 0)), 0)
  equal(journal.record(workerObservation([{ ...active, state: 'idle', last: 'idle' }, unknown], 1)), 1)
  const [event] = journal.events()
  equal(event.subject.id, entityId('worker', home.id, active.id, active.gen))
  deepEqual(event.change, { field: 'current_state', before: 'working', after: 'idle' })
  equal(event.evidence.historical_last_event, null)
  equal(journal.record(workerObservation([active, unknown], 2)), 1)
  deepEqual(journal.events()[1].change, { field: 'current_state', before: 'idle', after: 'working' })
  const [health] = journal.sources()
  equal(health.last_success_at, at(3))
  equal(health.health, 'partial')
  equal(health.counts.current_state_unavailable, 1)

  const reader = new DatabaseSync(path, { readOnly: true })
  try {
    const row = reader.prepare('SELECT * FROM worker_samples WHERE entity_id = ?')
      .get(entityId('worker', home.id, unknown.id, unknown.gen))
    equal(row.current_state, 'unknown')
    equal(row.snapshot_id, health.last_snapshot_id)
    equal(row.reason, 'current state could not be verified')
    equal(JSON.parse(row.evidence).state_source, 'status-log')
  } finally {
    reader.close()
  }
})

test('incomplete worker inventories do not advance the journal', async t => {
  const path = await temp(t)
  const fixture = { ...home, path, codeRoot: path }
  await mkdir(join(path, 'bin'))
  const command = join(path, 'bin', 'fm-fleet-snapshot.sh')
  const journal = new Journal(join(path, 'journal.sqlite'))
  t.after(() => journal.close())
  journal.register(workers)
  const first = { id: 'first-worker', gen: 'gen-1', state: 'working' }
  const second = { id: 'second-worker', gen: 'gen-2', state: 'working' }
  const poll = async (minute, change) => {
    const fleet = JSON.parse(encodeFleet(at(minute), [first, second]))
    fleet.fm_home = path
    change(fleet)
    await writeFile(command, `#!/bin/sh
cat <<'FLEET'
${JSON.stringify(fleet)}
FLEET
`, { mode: 0o700 })
    return observe(fixture, workers, path, { now: () => new Date(at(minute)) })
  }
  const failures = [
    fleet => { fleet.tasks[1].id = null },
    fleet => { fleet.tasks[1].spawn_gen = null },
    fleet => { Object.assign(fleet.tasks[1], { spawn_gen: null, remote: {} }) },
    fleet => { fleet.main_inventory = { valid: false } },
    fleet => { delete fleet.main_inventory },
  ]
  for (const [minute, fail] of failures.entries()) {
    equal(journal.record(await poll(minute, fail)), 0)
    const [health] = journal.sources()
    equal(health.health, 'partial')
    equal(health.last_generated_at, null)
    equal(health.last_snapshot_id, null)
  }
  equal(journal.record(await poll(failures.length, () => {})), 0)
  equal(journal.record(await poll(failures.length + 1, fleet => { fleet.tasks[1].current_state.state = 'parked' })), 1)
  equal(journal.events()[0].change.before, 'working')
})

test('unchanged markdown uses the fast path and a new local date reevaluates the hold', async t => {
  const path = await temp(t)
  const fixture = { ...home, path, codeRoot: path, markdownFastPath: true }
  const backlog = join(path, 'data', 'backlog.md')
  const script = join(path, 'bin', 'fm-tasks-axi.sh')
  await mkdir(join(path, 'bin'))
  await mkdir(join(path, 'data'))
  await writeFile(backlog, 'Synthetic immutable backlog\n')
  const output = day => encode({
    count: 1,
    tasks: [row('sample-hold', { hold_kind: 'future', hold_reason: 'Synthetic hold', hold_until: '2026-01-02', held: day })],
  })
  await writeFile(script, `#!/bin/sh
[ "$FM_HOME" = '${path}' ] && [ "$1" = list ] || exit 2
if [ "$EVENTS_TEST_DAY" = old ]; then
cat <<'OLD'
${output('yes')}
OLD
else
cat <<'NEW'
${output('no')}
NEW
fi
`, { mode: 0o700 })
  const journal = new Journal(join(path, 'journal.sqlite'))
  t.after(() => {
    journal.close()
    delete process.env.EVENTS_TEST_DAY
  })
  journal.register(tasks)
  const taskCache = {}
  const options = date => ({ now: () => new Date(date), taskCache })
  const fingerprint = await stat(backlog, { bigint: true })
  process.env.EVENTS_TEST_DAY = 'old'
  journal.record(await observe(fixture, tasks, path, options(new Date(2026, 0, 1, 23, 59, 20))))
  process.env.EVENTS_TEST_DAY = 'new'
  const cached = await observe(fixture, tasks, path, options(new Date(2026, 0, 1, 23, 59, 40)))
  equal(cached.method, 'markdown-fingerprint')
  equal(journal.record(cached), 0)
  const after = await observe(fixture, tasks, path, options(new Date(2026, 0, 2, 0, 0, 0)))
  equal(after.method, 'tasks-axi-list')
  equal(journal.record(after), 2)
  deepEqual(journal.events().map(event => event.change), [
    { field: 'held', before: true, after: false },
    { field: 'ready', before: false, after: true },
  ])
  equal((await stat(backlog, { bigint: true })).mtimeNs, fingerprint.mtimeNs)
  equal(await readFile(backlog, 'utf8'), 'Synthetic immutable backlog\n')
})

test('watch resumes after a cursor and prints each event once across multiple passes', async t => {
  const path = join(await temp(t), 'journal.sqlite')
  const journal = new Journal(path)
  t.after(() => journal.close())
  journal.register(tasks)
  journal.record(taskObservation([row('sample-a')], 0))
  journal.record(taskObservation([row('sample-a', { priority: 1 })], 1))
  const child = spawn(process.execPath, [cli, 'watch', '--db', path, '--after', '0', '--type', 'task', '--source', 'firstmate'])
  const done = new Promise(resolve => child.once('exit', resolve))
  t.after(() => {
    child.kill('SIGTERM')
    return done
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  for (let attempt = 0; attempt < 50 && !stdout.includes('#1 '); attempt++) await sleep(50)
  match(stderr, /Watching from sequence 0/)
  match(stdout, /\[replay\/fixture\].*#1 /)
  journal.record(taskObservation([row('sample-a', { priority: 2 })], 2))
  for (let attempt = 0; attempt < 50 && !stdout.includes('#2 '); attempt++) await sleep(50)
  match(stdout, /\[fixture\].*#2 /)
  equal(stdout.split('#1 ').length, 2)
  child.kill('SIGTERM')
  equal(await done, 0)
  for (const command of ['watch', 'replay']) {
    await rejects(exec(process.execPath, [cli, command, '--db', path, '--source', tasks.source_id]),
      error => error.code === 2 && /--source must be firstmate/.test(error.stderr))
  }
  await rejects(exec(process.execPath, [cli, 'watch', '--db', path, '--after', '-1']), { code: 2 })
})

import { deepEqual, equal, match, ok, rejects, throws } from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { encode } from '@toon-format/toon'
import { entityId, fleetPullRequests, observeHome, parseTasks, parseWorkers, sourcesFor } from '../firstmate.js'
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

function taskObservation(rows, minute, source = tasks, records = rows.map(({ id }) => ({ id, links: [] })), generated = at(minute + 1)) {
  const text = encode({ count: rows.length, tasks: rows })
  const fleet = JSON.stringify({ schema: 'fm-fleet-snapshot.v1', fm_home: home.path, generated,
    main_inventory: { valid: true }, backlog: { present: true, records } })
  return {
    source, started_at: at(minute), observed_at: at(minute + 1), health: 'ok',
    entries: parseTasks(text, source.home_id),
    pullRequests: fleetPullRequests(fleet, home.path, at(minute + 1), at(minute + 1)),
  }
}

function workerObservation(samples, minute, observedAt = at(minute + 1)) {
  const generated = at(minute)
  const text = encodeFleet(generated, samples)
  const payload = parseWorkers(text, home, generated, observedAt)
  return {
    source: workers, started_at: generated, observed_at: observedAt,
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

test('journal writer rejects public database and sidecar files', async t => {
  const directory = await temp(t)
  for (const [index, suffix] of ['', '-wal', '-shm', '-journal'].entries()) {
    const path = join(directory, `journal-${index}.sqlite`)
    const exposed = path + suffix
    await writeFile(exposed, '')
    await chmod(exposed, 0o644)
    throws(() => new Journal(path), /owner-only access/)
    equal((await stat(exposed)).size, 0)
  }
})

test('journal writer rejects directories that allow file replacement', async t => {
  const parent = await temp(t)
  const directory = join(parent, 'private')
  const path = join(directory, 'journal.sqlite')
  const writer = new Journal(path)
  writer.close()

  await chmod(directory, 0o770)
  throws(() => new Journal(path), /service-owned journal directory/)
  const reader = new Journal(path, { readOnly: true })
  equal(reader.tail(), 0)
  reader.close()

  await chmod(directory, 0o700)
  await chmod(parent, 0o770)
  throws(() => new Journal(path), /service-owned journal directory/)
})

test('journal writer validates directory aliases before creating missing components', async t => {
  const root = await temp(t)
  const shared = join(root, 'shared')
  const target = join(root, 'target')
  await mkdir(shared)
  await mkdir(target)
  await symlink(target, join(shared, 'alias'), 'dir')
  throws(() => new Journal(join(shared, 'alias', 'missing', 'journal.sqlite')), /service-owned journal directory/)
  await rejects(stat(join(target, 'missing')), { code: 'ENOENT' })
})

test('home binding survives restart and is shared by task and worker sources', async t => {
  const path = await temp(t)
  const db = join(path, 'journal.sqlite')
  const original = { ...home, path: join(path, 'original-home') }
  const [originalTasks, originalWorkers] = sourcesFor(original)
  await mkdir(original.path)
  const baseline = new Journal(db)
  baseline.register(originalTasks)
  baseline.record(taskObservation([row('sample-a')], 0))
  baseline.close()

  const journal = new Journal(db)
  t.after(() => journal.close())
  const rebound = { ...home, path: join(path, 'different-home') }
  await mkdir(rebound.path)
  throws(() => journal.register(sourcesFor(rebound)[1]), /already bound/)

  const alias = join(path, 'current')
  await symlink(original.path, alias)
  await rm(alias)
  await symlink(rebound.path, alias)
  const added = { ...home, id: 'example:east', path: join(path, 'new-home') }
  await mkdir(added.path)
  const config = join(path, 'config.json')
  await writeFile(config, JSON.stringify({ homes: [added, { ...rebound, path: alias }] }))
  for (const command of ['serve', 'observe']) {
    await rejects(exec(cli, [command, '--config', config, '--db', db]),
      error => error.code === 1 && /already bound/.test(error.stderr))
  }
  const renamed = { ...original, id: 'example:renamed' }
  await writeFile(config, JSON.stringify({ homes: [renamed] }))
  for (const command of ['serve', 'observe']) {
    await rejects(exec(cli, [command, '--config', config, '--db', db]),
      error => error.code === 1 && /already bound/.test(error.stderr))
  }
  deepEqual(journal.sources().map(source => source.source_id), [tasks.source_id])
  journal.register(sourcesFor({ ...added, path: rebound.path })[0])
  journal.register(originalTasks)
  journal.register(originalWorkers)
  equal(journal.tail(), 0)
  const fresh = new Journal(join(path, 'new-journal.sqlite'))
  fresh.registerSources(sourcesFor(renamed))
  equal(fresh.sources().length, 2)
  fresh.close()
})

test('full configuration registration deconfigures removed sources without losing history', async t => {
  const path = join(await temp(t), 'journal.sqlite')
  const journal = new Journal(path)
  t.after(() => journal.close())
  const east = { ...home, id: 'example:east', path: '/example/east' }
  const eastSources = sourcesFor(east)
  const [eastTasks] = eastSources
  journal.registerSources([tasks, workers, ...eastSources], { reconcile: true })
  journal.record(taskObservation([], 0, eastTasks))
  const task = row('sample-task')
  const first = 'https://github.com/example/repo/pull/12'
  const second = 'https://github.com/example/repo/pull/13'
  journal.record(taskObservation([task], 1, eastTasks, [{ id: task.id, pr_url: first }]))
  const before = journal.sources().find(source => source.source_id === eastTasks.source_id)
  const events = journal.events()

  journal.registerSources([tasks, workers], { reconcile: true })
  const { stdout } = await exec(cli, ['sources', '--db', path])
  match(stdout, /east:task .*deconfigured/)
  match(stdout, /east:worker .*deconfigured/)
  const removed = journal.sources().find(source => source.source_id === eastTasks.source_id)
  equal(removed.last_snapshot_id, before.last_snapshot_id)
  deepEqual(journal.events(), events)
  throws(() => journal.registerSources(sourcesFor({ ...east, id: 'renamed' })), /already bound/)

  journal.registerSources(eastSources)
  equal(journal.sources().find(source => source.source_id === eastTasks.source_id).health, 'ok')
  equal(journal.sources().find(source => source.source_id === tasks.source_id).health, 'pending')
  equal(journal.record(taskObservation([task], 2, eastTasks, [{ id: task.id, pr_url: second }])), 1)
  deepEqual(journal.events().at(-1).change, { field: 'pull_requests', before: [first], after: [second] })
  equal(journal.events().at(-1).sequence, events.at(-1).sequence + 1)
})

test('CLI rejects oversized intervals and JSON source health output', async () => {
  for (const command of ['watch', 'replay']) {
    await rejects(exec(cli, [command, '--type', '']),
      error => error.code === 2 && /--type must be task, worker, ticket, pr, tag, deployment or mate/.test(error.stderr))
  }
  for (const interval of ['3601', '2147484']) {
    await rejects(exec(cli, ['serve', '--interval', interval]),
      error => error.code === 2 && /--interval must be at most 3600/.test(error.stderr))
  }
  await rejects(exec(cli, ['sources', '--json']),
    error => error.code === 2 && /--json is unsupported for sources/.test(error.stderr))
})

test('fleet PR links rebaseline silently after a coverage gap', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.register(tasks)
  const first = row('sample-a', { links: 'pr:https://github.com/example/repo/pull/12,pr:https://github.com/other/repo/pull/9' })
  const pr = 'https://github.com/example/repo/pull/12'
  const next = 'https://github.com/example/repo/pull/13'
  journal.record(taskObservation([first], 0, tasks, [{ id: first.id, pr_url: pr }]))
  equal(journal.record(taskObservation([{ ...first, priority: 1 }], 1, tasks, [{
    id: first.id, links: [{}], pr_url: null,
  }])), 1)
  equal(journal.events().at(-1).evidence.pr_link_coverage, 'unobserved')
  equal(journal.record(taskObservation([{ ...first, priority: 2 }], 2, tasks, [{ id: first.id, links: [] }])), 1)
  equal(journal.events().at(-1).evidence.pr_link_coverage, 'rebaselined')
  equal(journal.record(taskObservation([{ ...first, priority: 2 }], 3, tasks, [{
    id: first.id, links: [{ url: next }, { url: 'https://github.com/example/repo/issues/9' }], pr_url: next,
  }])), 1)
  const changed = journal.events().at(-1)
  deepEqual(changed.change, {
    field: 'pull_requests', before: [], after: [next],
  })
  equal(changed.observation.observed_between.after, at(2))
  equal(changed.evidence.source_reference.interface, 'bin/fm-fleet-snapshot.sh --json')
  equal(changed.evidence.state_source, 'fleet-snapshot backlog')
  equal(journal.record(taskObservation([], 4)), 0)
  equal(journal.record(taskObservation([{ ...first, priority: 3 }], 5, tasks, [{ id: first.id, pr_url: pr }])), 1)
  const returned = journal.events().at(-1)
  equal(returned.change.field, 'priority')
  equal(returned.evidence.pr_link_coverage, 'rebaselined')

  equal(journal.record({ source: tasks, started_at: at(6), observed_at: at(7), health: 'unavailable' }), 0)
  equal(journal.record(taskObservation([{ ...first, priority: 4 }], 7, tasks, [{ id: first.id, pr_url: next }])), 1)
  equal(journal.events().at(-1).change.field, 'priority')
  equal(journal.events().at(-1).evidence.pr_link_coverage, 'rebaselined')

  const newTask = row('new-task')
  equal(journal.record(taskObservation([newTask], 8, tasks, [{ id: newTask.id, links: [pr] }])), 2)
  const [observed, links] = journal.events().slice(-2)
  equal(observed.evidence.source_reference.interface, tasks.command)
  equal(links.evidence.source_reference.interface, 'bin/fm-fleet-snapshot.sh --json')
})

test('an older PR projection with the same fleet generation cannot reverse links after restart', async t => {
  const path = join(await temp(t), 'journal.sqlite')
  const task = row('sample-task')
  const accepted = 'https://github.com/example/repo/pull/13'
  const older = 'https://github.com/example/repo/pull/12'
  const baseline = new Journal(path)
  baseline.register(tasks)
  equal(baseline.record(taskObservation([task], 0, tasks, [{ id: task.id, pr_url: accepted }], at(1))), 0)
  baseline.close()

  const journal = new Journal(path)
  t.after(() => journal.close())
  const retry = taskObservation([{ ...task, priority: 2 }], 0, tasks, [{ id: task.id, pr_url: older }])
  equal(journal.record({ ...retry, started_at: at(1) }), 1)
  const [event] = journal.events()
  equal(event.change.field, 'priority')
  equal(event.evidence.pr_link_coverage, 'unobserved')
  equal(event.observed_at, at(1))
  equal(event.observation.observed_between.by, at(1))
  const [status] = journal.sources()
  equal(status.health, 'ok')
  equal(status.last_generated_at, at(1))
  equal(status.last_success_at, at(1))
  deepEqual(status.counts, { pr_links_unobserved: 1 })

  const reader = new DatabaseSync(path, { readOnly: true })
  try {
    const { fields } = reader.prepare('SELECT fields FROM entities WHERE source_id = ?').get(tasks.source_id)
    deepEqual(JSON.parse(fields).pull_requests, [accepted])
  } finally {
    reader.close()
  }
})

test('a rejected explicit PR URL leaves coverage unobserved', async t => {
  const path = join(await temp(t), 'journal.sqlite')
  const journal = new Journal(path)
  t.after(() => journal.close())
  journal.register(tasks)
  const task = row('sample-task')
  const pr = 'https://github.com/example/repo/pull/12'
  journal.record(taskObservation([task], 0, tasks, [{ id: task.id, pr_url: pr }]))

  for (const minute of [1, 2]) {
    const record = { id: task.id, pr_url: `${pr}?diff=split`, ...(minute === 2 ? { links: [pr] } : {}) }
    equal(journal.record(taskObservation([{ ...task, priority: minute }], minute, tasks, [record])), 1)
    const event = journal.events().at(-1)
    equal(event.change.field, 'priority')
    equal(event.evidence.pr_link_coverage, 'unobserved')
    equal(journal.sources()[0].last_generated_at, at(1))
  }
  const reader = new DatabaseSync(path, { readOnly: true })
  try {
    const { fields } = reader.prepare('SELECT fields FROM entities').get()
    deepEqual(JSON.parse(fields).pull_requests, [pr])
  } finally {
    reader.close()
  }
})

test('rejected structured PR candidates leave coverage unobserved', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.register(tasks)
  const task = row('sample-task')
  const pr = 'https://github.com/example/repo/pull/12'
  journal.record(taskObservation([task], 0, tasks, [{ id: task.id, links: [pr] }]))
  const rejected = [
    'https://github.com./example/repo/pull/12',
    'https://github.com:65536/example/repo/pull/12',
    'https://github.com:invalid/example/repo/pull/12',
    'https://user:secret@github.com/owner/repo/pull/99',
    'https://github.com/owner/repo/PULL/99',
    'https:github.com/owner/repo/pull/99',
    'https://github.com/owner/repo/issues/../pull/99',
    'https://github.com/owner/./pull/99',
    'https://github.com/owner/../pull/99',
    'https://github.com/owner/repo/pull/99?diff=split',
    'https://github.com/owner/repo/pull/99#files',
    `${pr},pr:https://github.com/other/repo/pull/9`,
  ]
  for (const [index, url] of rejected.entries()) {
    const minute = index + 1
    equal(journal.record(taskObservation([{ ...task, priority: minute % 5 }], minute, tasks, [
      { id: task.id, links: [{ url }] },
    ])), 1)
    equal(journal.events().at(-1).change.field, 'priority')
    equal(journal.events().at(-1).evidence.pr_link_coverage, 'unobserved')
    equal(journal.sources()[0].last_generated_at, at(1))
  }
})

test('explicit null PR data witnesses removal while an absent projection preserves task timing', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.register(tasks)
  const task = row('sample-task')
  const pr = 'https://github.com/example/repo/pull/12'
  journal.record(taskObservation([task], 0, tasks, [{ id: task.id, pr_url: pr }]))
  const removed = taskObservation([task], 1, tasks, [{ id: task.id, pr_url: null }])
  equal(journal.record({ ...removed, observed_at: at(1) }), 1)
  const [event] = journal.events()
  deepEqual(event.change, { field: 'pull_requests', before: [pr], after: [] })
  equal(event.observed_at, at(2))

  const missing = taskObservation([{ ...task, priority: 1 }], 2, tasks, [{ id: task.id }], at(3))
  equal(journal.record({ ...missing, observed_at: at(2) }), 1)
  const changed = journal.events().at(-1)
  equal(changed.change.field, 'priority')
  equal(changed.observed_at, at(2))
  equal(changed.evidence.pr_link_coverage, 'unobserved')
  equal(journal.sources()[0].last_attempt_at, at(2))
  equal(journal.sources()[0].last_generated_at, at(2))

  const added = row('new-task')
  const mixed = taskObservation([{ ...task, priority: 2 }, added], 3, tasks, [
    { id: added.id, pr_url: pr },
  ])
  equal(journal.record({ ...mixed, observed_at: at(3) }), 3)
  const [addedEvent, linksEvent, priorityEvent] = journal.events().slice(-3)
  equal(addedEvent.event_type, 'task.observed')
  equal(Object.hasOwn(addedEvent.change.after, 'pull_requests'), false)
  equal(addedEvent.evidence.pr_link_source, undefined)
  equal(addedEvent.observed_at, at(3))
  equal(addedEvent.observation.observed_between.by, at(3))
  equal(addedEvent.observation.batch_id, priorityEvent.observation.batch_id)
  equal(linksEvent.event_type, 'task.pull_requests.observed')
  deepEqual(linksEvent.change, { field: 'pull_requests', after: [pr] })
  equal(linksEvent.observed_at, at(4))
  equal(linksEvent.observation.observed_between.by, at(4))
  ok(linksEvent.observation.batch_id !== addedEvent.observation.batch_id)
  equal(priorityEvent.change.field, 'priority')
  equal(priorityEvent.observed_at, at(3))
  equal(priorityEvent.observation.observed_between.by, at(3))
  equal(journal.sources()[0].last_generated_at, at(4))
})

test('reversed task and worker reads preserve accepted snapshots and events', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.registerSources([tasks, workers])
  const task = row('sample-task')
  const worker = { id: task.id, gen: 'gen-1', state: 'working' }
  journal.record(taskObservation([task], 0))
  journal.record(workerObservation([worker], 1, at(1)))
  const baseline = journal.sources()
  const changedWorker = { ...worker, state: 'parked' }
  for (const observation of [
    taskObservation([{ ...task, state: 'done' }], 10),
    workerObservation([changedWorker], 10),
  ]) {
    deepEqual(journal.recordAttempt({ ...observation, observed_at: at(-1) }), { written: 0, complete: false })
  }
  for (const [index, source] of journal.sources().entries()) {
    equal(source.health, 'stale')
    for (const field of ['last_attempt_at', 'last_success_at', 'last_snapshot_id', 'last_generated_at']) {
      equal(source[field], baseline[index][field])
    }
  }
  equal(journal.tail(), 0)
  equal(journal.record(taskObservation([{ ...task, state: 'done' }], 3)), 2)
  equal(journal.record(workerObservation([changedWorker], 4, at(4))), 1)
})

test('invalid fleet windows leave valid task fields observable', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.register(tasks)
  const task = row('sample-task')
  const pr = 'https://github.com/example/repo/pull/12'
  journal.record(taskObservation([task], 0))
  for (const [minute, window] of [
    [2, { started_at: at(4), observed_at: at(3) }],
    [4, { started_at: at(4), observed_at: at(6), generated_at: at(4) }],
    [6, { generated_at: at(1), links: new Map(), backlogAbsent: true }],
  ]) {
    const attempt = taskObservation([{ ...task, priority: minute / 2 }], minute, tasks, [{ id: task.id, pr_url: pr }])
    const pullRequests = { ...attempt.pullRequests, ...window }
    deepEqual(journal.recordAttempt({ ...attempt, pullRequests }), { written: 1, complete: false })
    const event = journal.events().at(-1)
    equal(event.change.field, 'priority')
    equal(event.observed_at, attempt.observed_at)
    equal(event.evidence.pr_link_coverage, 'unobserved')
    const [status] = journal.sources()
    equal(status.last_success_at, attempt.observed_at)
    equal(status.last_generated_at, at(1))
    deepEqual(status.counts, { pr_links_unobserved: 1 })
  }
})

test('fleet backlog absence requires an explicit false presence marker', () => {
  const envelope = { schema: 'fm-fleet-snapshot.v1', fm_home: home.path, generated: at(0), main_inventory: { valid: true } }
  for (const backlog of [undefined, {}, { present: 'false' }]) {
    equal(fleetPullRequests(JSON.stringify({ ...envelope, backlog }), home.path, at(0), at(1)), null)
  }
})

test('confirmed backlog absence advances freshness without worker inventory', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.registerSources([tasks, workers])
  const task = row('sample-task')
  const pr = 'https://github.com/example/repo/pull/12'
  journal.record(taskObservation([task], 0, tasks, [{ id: task.id, pr_url: pr }]))
  const generation = at(2)
  const text = JSON.stringify({
    schema: 'fm-fleet-snapshot.v1', fm_home: home.path, generated: generation,
    backlog: { present: false },
  })
  const observe = (priority, time) => journal.recordAttempts([
    {
      ...taskObservation([{ ...task, priority }], 2), started_at: time, observed_at: time,
      pullRequests: fleetPullRequests(text, home.path, time, time),
    },
    { source: workers, started_at: time, observed_at: time, health: 'partial' },
  ])
  const taskStatus = () => journal.sources().find(source => source.type === 'task')
  observe(1, generation)
  deepEqual(taskStatus().counts, { pr_links_unobserved: 1, fleet_backlog_absent: 1 })
  const repeated = new Date(Date.parse(generation) + 500).toISOString()
  observe(2, repeated)
  deepEqual(taskStatus().counts, { pr_links_unobserved: 1 })
  equal(taskStatus().last_success_at, repeated)
  deepEqual(journal.events().map(event => event.change.field), ['priority', 'priority'])
  const stored = journal.db.prepare('SELECT fields FROM entities WHERE source_id = ?').get(tasks.source_id)
  deepEqual(JSON.parse(stored.fields).pull_requests, [pr])
})

test('confirmed backlog absence survives both inventory failures', async t => {
  const path = await temp(t)
  const fixture = { ...home, path }
  const bin = join(path, 'bin')
  await mkdir(bin)
  const generation = at(2)
  const fleet = { schema: 'fm-fleet-snapshot.v1', fm_home: path, generated: generation, backlog: { present: false } }
  const writeFleet = snapshot => writeFile(join(bin, 'fm-fleet-snapshot.sh'),
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(snapshot)}'\n`, { mode: 0o700 })
  await writeFleet({
    ...fleet, main_inventory: { valid: true },
    backlog: { present: true, records: [{ id: 'sample-task', links: ['https://github.com/example/repo/pull/12'] }] },
  })
  const [unavailable] = await observeHome(fixture, path, { now: () => new Date(generation) })
  equal(unavailable.health, 'unavailable')
  equal(unavailable.pullRequests, null)
  await writeFleet(fleet)
  const journal = new Journal(join(path, 'journal.sqlite'))
  t.after(() => journal.close())
  journal.registerSources(sourcesFor(fixture))
  const taskWindow = [at(3), at(3), at(3), at(3)]
  const observations = await observeHome(fixture, path, { now: () => new Date(taskWindow.shift() ?? generation) })
  equal(observations[0].observed_at, at(3))
  equal(observations[0].pullRequests.observed_at, generation)
  journal.recordAttempts(observations)
  const [taskStatus, workerStatus] = journal.sources()
  equal(taskStatus.health, 'unavailable')
  equal(taskStatus.reason, 'read command is missing or inaccessible')
  deepEqual(taskStatus.counts, { fleet_backlog_absent: 1 })
  equal(workerStatus.health, 'partial')
  equal(taskStatus.last_snapshot_id, null)
  equal(workerStatus.last_snapshot_id, null)

  const repeated = new Date(Date.parse(generation) + 500).toISOString()
  await writeFile(join(bin, 'fm-tasks-axi.sh'),
    `#!/bin/sh\nprintf '%s\\n' '${encode({ count: 1, tasks: [row('sample-task')] })}'\n`, { mode: 0o700 })
  journal.recordAttempts(await observeHome(fixture, path, { now: () => new Date(repeated) }))
  const recovered = journal.sources().find(source => source.type === 'task')
  equal(recovered.last_success_at, repeated)
  deepEqual(recovered.counts, { pr_links_unobserved: 1 })
  equal(journal.tail(), 0)
})

test('rejected and unavailable reads cannot lower the accepted window floor', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.registerSources([tasks, workers])
  const observations = [
    minute => taskObservation([row('sample-task', { priority: minute ? 1 : 0 })], minute, tasks, []),
    minute => workerObservation([{ id: 'sample-task', gen: 'gen-1', state: minute ? 'parked' : 'working' }], minute),
  ]
  for (const read of observations) {
    const baseline = read(0)
    journal.record({ ...baseline, observed_at: at(5) })
    const status = () => journal.sources().find(source => source.source_id === baseline.source.source_id)
    const accepted = status()
    deepEqual(journal.recordAttempt(read(1)), { written: 0, complete: false })
    equal(status().health, 'stale')
    for (const field of ['last_success_at', 'last_snapshot_id', 'last_generated_at']) {
      equal(status()[field], accepted[field])
    }
    journal.record({ ...read(2), entries: undefined, health: 'unavailable' })
    deepEqual(journal.recordAttempt(read(4)), { written: 0, complete: false })
    journal.record({ ...read(10), entries: undefined, health: 'unavailable' })
    equal(journal.record(read(5)), 1)
  }
})

test('an overlapping task inventory cannot support a worker relationship', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.registerSources([tasks, workers])
  const task = row('sample-task')
  const worker = { id: task.id, gen: 'gen-1', state: 'working' }
  journal.record({ ...taskObservation([task], 0), observed_at: at(3) })
  journal.record(workerObservation([worker], 0))
  equal(journal.record(workerObservation([{ ...worker, state: 'parked' }], 1)), 1)
  deepEqual(journal.events()[0].change, { field: 'current_state', before: 'working', after: 'parked' })
  deepEqual(journal.events()[0].related, [])

  equal(journal.recordAttempt(taskObservation([], 1)).complete, false)
  equal(journal.record(workerObservation([worker], 3)), 1)
  deepEqual(journal.events().at(-1).related, [])

  journal.record(taskObservation([task], 4))
  equal(journal.recordAttempt({
    source: tasks, started_at: at(3), observed_at: at(4),
    health: 'partial', reason: 'synthetic malformed inventory',
  }).complete, false)
  equal(journal.sources().find(source => source.type === 'task').health, 'partial')
  equal(journal.record(workerObservation([{ ...worker, state: 'parked' }], 5, at(5))), 1)
  deepEqual(journal.events().at(-1).related, [])
})

test('worker inventory respects accepted PR fleet windows and can share a fresh read', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.registerSources([tasks, workers])
  const task = row('sample-task')
  journal.record(taskObservation([task], 0))
  const prOnly = taskObservation([task], 1, tasks, [{ id: task.id, links: [] }])
  journal.record({ ...prOnly, pullRequests: { ...prOnly.pullRequests, observed_at: at(5) } })
  const changedTask = { ...task, priority: 1 }
  const pr = 'https://github.com/example/repo/pull/13'
  const overlap = taskObservation([changedTask], 3, tasks, [{ id: task.id, pr_url: pr }])
  deepEqual(journal.recordAttempt(overlap), { written: 1, complete: false })
  const [event] = journal.events()
  equal(event.change.field, 'priority')
  equal(event.evidence.pr_link_coverage, 'unobserved')
  equal(journal.sources().find(source => source.type === 'task').last_success_at, at(4))
  journal.record({ ...workerObservation([], 2), entries: undefined, health: 'unavailable' })
  deepEqual(journal.recordAttempt(workerObservation([], 3)), { written: 0, complete: false })
  equal(journal.sources().find(source => source.type === 'worker').last_generated_at, null)

  const fresh = taskObservation([changedTask], 5, tasks, [{ id: task.id, pr_url: pr }])
  deepEqual(journal.recordAttempt(fresh), { written: 0, complete: true })
  equal(journal.recordAttempt(workerObservation([], 6, at(6))).complete, true)
  equal(journal.recordAttempt(workerObservation([], 6, at(6))).complete, false)
})

test('a fleet window overlapping accepted worker evidence cannot advance PR links', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.registerSources([tasks, workers])
  const task = row('sample-task')
  journal.record(taskObservation([task], 0))
  journal.record(workerObservation([], 2, at(5)))
  const pr = 'https://github.com/example/repo/pull/13'
  const attempt = taskObservation([{ ...task, priority: 2 }], 2, tasks, [{ id: task.id, pr_url: pr }])
  deepEqual(journal.recordAttempt(attempt), { written: 1, complete: false })
  deepEqual(journal.recordAttempt(workerObservation([], 2)), { written: 0, complete: false })
  const [event] = journal.events()
  equal(event.change.field, 'priority')
  equal(event.evidence.pr_link_coverage, 'unobserved')
  equal(journal.sources().find(source => source.type === 'task').last_generated_at, at(1))
})

test('worker arrivals use the matching prior fleet window when PR links share the new read', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.registerSources([tasks, workers])
  const task = row('sample-task')
  const poll = (minute, samples) => journal.recordAttempts([
    taskObservation([task], minute - 1),
    workerObservation(samples, minute, at(minute)),
  ])
  const worker = { id: task.id, gen: 'gen-1', state: 'working' }
  poll(1, [])
  const previous = journal.sources().find(source => source.type === 'worker')
  poll(2, [worker])
  const [observed] = journal.events()
  equal(observed.event_type, 'worker.observed')
  equal(observed.observation.previous_snapshot, previous.last_snapshot_id)
  deepEqual(observed.observation.observed_between, { after: at(1), by: at(2) })

  poll(3, [])
  journal.record(taskObservation([task], 3))
  poll(5, [worker])
  const returned = journal.events().at(-1)
  equal(returned.event_type, 'worker.inventory.entered')
  deepEqual(returned.observation.observed_between, { after: null, by: at(5) })
})

test('PR projection rejects a fleet generation accepted by workers in a prior pass', async t => {
  const path = join(await temp(t), 'journal.sqlite')
  const initial = row('initial-task')
  const next = row('new-task')
  const pr = 'https://github.com/example/repo/pull/13'
  const baseline = new Journal(path)
  baseline.registerSources([tasks, workers])
  baseline.record(taskObservation([initial], 0, tasks, []))
  baseline.record({ source: tasks, started_at: at(1), observed_at: at(2), health: 'unavailable' })
  baseline.record(workerObservation([], 3, at(3)))
  baseline.close()

  const journal = new Journal(path)
  t.after(() => journal.close())
  equal(journal.record(taskObservation([initial, next], 2, tasks, [{ id: next.id, pr_url: pr }])), 1)
  const [observed] = journal.events()
  equal(observed.event_type, 'task.observed')
  equal(observed.evidence.pr_link_coverage, undefined)
  equal(Object.hasOwn(observed.change.after, 'pull_requests'), false)
  equal(journal.sources().find(source => source.type === 'task').last_generated_at, null)

  equal(journal.record(taskObservation([initial, next, row('fresh-task')], 3, tasks, [{ id: 'fresh-task', pr_url: pr }])), 2)
  deepEqual(journal.events().at(-1).change.after, [pr])
  equal(journal.record(workerObservation([], 4, at(4))), 0)
  equal(journal.sources().find(source => source.type === 'worker').last_generated_at, at(4))
})

test('task readiness requires a valid kind', () => {
  const task = row('sample-task')
  const { kind, ...missingKind } = task
  for (const invalid of [missingKind, { ...task, kind: '-' }, { ...task, kind: 1 }]) {
    throws(() => parseTasks(encode({ count: 1, tasks: [invalid] }), home.id), /invalid or duplicate tasks-axi row/)
  }
  equal(parseTasks(encode({ count: 1, tasks: [{ ...task, kind: 'public-followup' }] }), home.id)[0].fields.ready, false)
  equal(parseTasks(encode({ count: 1, tasks: [{ ...task, kind }] }), home.id)[0].fields.ready, true)
})

test('the live list and real home fleet projections work with a secondmate registry', async t => {
  const path = await temp(t)
  const bin = join(path, 'bin')
  const data = join(path, 'data')
  const backlog = join(data, 'backlog.md')
  const calls = join(path, 'fleet-calls')
  const config = join(path, 'config.json')
  const db = join(path, 'journal.sqlite')
  await mkdir(bin)
  await mkdir(data)
  const pr = 'https://github.com/example/repo/pull/12'
  await writeFile(join(data, 'secondmates.md'), '# Secondmates\n')
  await writeFile(backlog, JSON.stringify({ present: true, records: [{ id: 'sample-task', links: [pr] }] }))
  await writeFile(config, JSON.stringify({ homes: [{ ...home, path }] }))
  const writeTasks = state => writeFile(join(bin, 'fm-tasks-axi.sh'), `#!/bin/sh
[ "$#" -eq 3 ] && [ "$1" = list ] && [ "$2" = --fields ] || exit 2
IFS=,
for field in $3; do
  case "$field" in
    blocked|blocked_by|body|closed|created|delivery_state|deps|held|hold_kind|hold_reason|hold_until|links|priority) ;;
    *) exit 2 ;;
  esac
done
cat <<'TASKS'
${encode({ count: 1, tasks: [row('sample-task', { state, kind: 'public-followup' })] })}
TASKS
`, { mode: 0o700 })
  await writeTasks('queued')
  await writeFile(join(bin, 'fm-fleet-snapshot.sh'), `#!/bin/sh
[ "$1" = --json ] && [ -z "${'$'}{FM_DATA_OVERRIDE+x}" ] || exit 2
echo call >> '${calls}'
if [ -f "$FM_HOME/data/backlog.md" ]; then
  backlog=$(cat "$FM_HOME/data/backlog.md")
  state=working
else
  backlog='{"present":false,"records":[]}'
  state=parked
fi
generated=$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)
printf '{"schema":"fm-fleet-snapshot.v1","fm_home":"%s","generated":"%s","main_inventory":{"valid":true},"secondmate_current":{"registry":{"present":true}},"tasks":[{"id":"sample-task","spawn_gen":"gen-1","remote":null,"current_state":{"state":"%s","source":"pane","observed_at":"%s","freshness":"fresh"}}],"backlog":%s}\\n' "$FM_HOME" "$generated" "$state" "$generated" "$backlog"
`, { mode: 0o700 })
  await exec(cli, ['observe', '--config', config, '--db', db])
  equal(await readFile(calls, 'utf8'), 'call\n')
  const { stdout } = await exec(cli, ['sources', '--db', db])
  match(stdout, /:task .*ok/)
  match(stdout, /:worker .*ok/)
  const journal = new Journal(db, { readOnly: true })
  t.after(() => journal.close())
  equal(journal.tail(), 0)
  const taskBefore = journal.sources().find(source => source.type === 'task')
  ok(taskBefore.last_snapshot_id)

  await writeTasks('done')
  await unlink(backlog)
  await rejects(exec(cli, ['observe', '--config', config, '--db', db]), { code: 1 })
  equal(await readFile(calls, 'utf8'), 'call\ncall\n')
  const missing = await exec(cli, ['sources', '--db', db])
  match(missing.stdout, /:task .*partial.*fleet snapshot backlog absent/)
  const taskAfter = journal.sources().find(source => source.type === 'task')
  equal(taskAfter.health, 'partial')
  deepEqual(taskAfter.counts, { pr_links_unobserved: 1, fleet_backlog_absent: 1 })
  ok(taskAfter.last_snapshot_id !== taskBefore.last_snapshot_id)
  deepEqual(journal.events().map(event => event.change), [
    { field: 'state', before: 'queued', after: 'done' },
    { field: 'current_state', before: 'working', after: 'parked' },
  ])
  const replay = await exec(cli, ['replay', '--db', db, '--type', 'worker', '--json'])
  const transition = JSON.parse(replay.stdout)
  deepEqual(transition.subject, { type: 'worker', id: entityId('worker', home.id, 'sample-task', 'gen-1') })
  deepEqual(transition.change, { field: 'current_state', before: 'working', after: 'parked' })
  equal(journal.events()[0].evidence.pr_link_coverage, 'unobserved')
  const stored = journal.db.prepare('SELECT fields FROM entities WHERE source_id = ?').get(taskAfter.source_id)
  deepEqual(JSON.parse(stored.fields).pull_requests, [pr])
})

test('observe reports unavailable reads behind the accepted journal watermark', async t => {
  const path = await temp(t)
  const config = join(path, 'config.json')
  const db = join(path, 'journal.sqlite')
  const configuredHome = { ...home, path }
  await writeFile(config, JSON.stringify({ homes: [configuredHome] }))
  const journal = new Journal(db)
  t.after(() => journal.close())
  const sources = sourcesFor(configuredHome)
  journal.registerSources(sources)
  const future = new Date(Date.now() + 60_000).toISOString()
  for (const source of sources) {
    journal.record({ source, started_at: future, observed_at: future, entries: [], health: 'ok' })
  }
  const baseline = journal.sources()

  await rejects(exec(cli, ['observe', '--config', config, '--db', db]), { code: 1 })
  for (const [index, source] of journal.sources().entries()) {
    equal(source.health, 'unavailable')
    for (const field of ['last_success_at', 'last_snapshot_id', 'last_generated_at']) {
      equal(source[field], baseline[index][field])
    }
  }
  equal(journal.tail(), 0)
})

test('baseline, direct Queued to Done, exact task fields, dedup and immutable restart replay', async t => {
  const path = join(await temp(t), 'journal.sqlite')
  const before = row('sample-a', { title: 'one, "two"', priority: 2 })
  const after = row('sample-a', {
    state: 'done', priority: 1, closed: '2026-01-02',
  })
  const baseline = new Journal(path)
  baseline.register(tasks)
  equal(baseline.record(taskObservation([before], 0)), 0)
  baseline.close()

  // The source changed while the collector was stopped.
  const journal = new Journal(path)
  const records = [{ id: after.id, links: [{ url: 'https://github.com/example/repo/pull/12' }] }]
  const updated = taskObservation([after], 2, tasks, records)
  equal(journal.record(updated), 5)
  equal(journal.record(updated), 0)
  equal(journal.record(taskObservation([after], 3, tasks, records)), 0)
  const events = journal.events()
  const state = events[0]
  deepEqual(events.map(event => event.change.field), ['state', 'closed', 'priority', 'ready', 'pull_requests'])
  deepEqual(state.change, { field: 'state', before: 'queued', after: 'done' })
  equal(state.occurred_at, null)
  deepEqual(state.observation.observed_between, { after: at(0), by: at(3) })
  equal(new Set(events.slice(0, 4).map(event => event.observation.batch_id)).size, 1)
  ok(events[4].observation.batch_id !== state.observation.batch_id)
  equal(events[4].change.after[0], 'https://github.com/example/repo/pull/12')
  journal.close()

  const restart = new Journal(path)
  equal(restart.record(taskObservation([after], 4, tasks, records)), 0)
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

test('a crash between fleet projections leaves neither projection committed', async t => {
  const path = join(await temp(t), 'journal.sqlite')
  const task = row('sample-a')
  const worker = { id: task.id, gen: 'gen-1', state: 'working' }
  const baseline = new Journal(path)
  baseline.registerSources([tasks, workers])
  baseline.recordAttempts([taskObservation([task], 0), workerObservation([worker], 1, at(1))])
  const before = baseline.sources()
  baseline.close()

  const taskRead = taskObservation([{ ...task, priority: 1 }], 2, tasks, [{
    id: task.id, pr_url: 'https://github.com/example/repo/pull/13',
  }])
  const workerRead = workerObservation([{ ...worker, state: 'parked' }], 3, at(3))
  const encoded = JSON.stringify([
    { ...taskRead, pullRequests: { ...taskRead.pullRequests, links: [...taskRead.pullRequests.links] } },
    workerRead,
  ])
  await rejects(exec(process.execPath, ['--input-type=module', '-e', `
    import { Journal } from ${JSON.stringify(new URL('../journal.js', import.meta.url).href)}
    class InterruptedJournal extends Journal {
      recordEntries(observation, ...args) {
        if (observation.source.type === 'worker') process.exit(42)
        return super.recordEntries(observation, ...args)
      }
    }
    const [path, encoded] = process.argv.slice(1)
    const observations = JSON.parse(encoded)
    observations[0].pullRequests.links = new Map(observations[0].pullRequests.links)
    new InterruptedJournal(path).recordAttempts(observations)
  `, path, encoded]), { code: 42 })

  const restarted = new Journal(path)
  t.after(() => restarted.close())
  deepEqual(restarted.sources(), before)
  equal(restarted.tail(), 0)
  deepEqual(restarted.recordAttempts([taskRead, workerRead]), [
    { written: 2, complete: true },
    { written: 1, complete: true },
  ])
  const events = restarted.events()
  deepEqual(events.map(event => event.change.field).sort(), ['current_state', 'priority', 'pull_requests'])
  const batchByField = new Map(events.map(event => [event.change.field, event.observation.batch_id]))
  equal(batchByField.get('pull_requests'), batchByField.get('current_state'))
  ok(batchByField.get('priority') !== batchByField.get('pull_requests'))
  equal(new Set(events.map(event => event.observation.current_snapshot)).size, 2)
})

test('missing, failed, partial and out-of-order task polls preserve the last witnessed state', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  const moved = sourcesFor({ ...home, id: 'example:east', path: '/example/east' })[0]
  journal.register(tasks)
  journal.register(moved)
  journal.record(taskObservation([row('sample-a')], 0))
  journal.record(taskObservation([], 0, moved))
  const cursor = journal.sources().find(source => source.source_id === tasks.source_id).last_snapshot_id

  journal.record({ source: tasks, started_at: at(1), observed_at: at(2), health: 'unavailable', reason: 'synthetic outage' })
  equal(journal.record({ ...taskObservation([row('sample-a', { state: 'done' })], 2),
    health: 'partial', reason: 'synthetic truncation' }), 0)
  equal(journal.sources().find(source => source.source_id === tasks.source_id).last_snapshot_id, cursor)
  equal(journal.record(taskObservation([row('sample-a', { state: 'done' })], 0)), 0)
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
  journal.record(taskObservation([row('sample-worker')], 0, tasks, []))
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
  equal(journal.record(workerObservation([{ ...sample, gen: 'gen-2', state: 'unknown' }], 3)), 2)
  equal(journal.record(workerObservation([{ ...sample, gen: 'gen-2', state: 'working' }], 4)), 1)
  equal(journal.record(workerObservation([{ ...sample, gen: 'gen-3', state: 'working' }], 5)), 2)
  const [, observedUnknown, firstDeparture, previouslyUnknown, newlySeen, secondDeparture] = journal.events()
  equal(observedUnknown.event_type, 'worker.observed')
  deepEqual(observedUnknown.change, { after: { current_state: 'unknown', reason: 'current state could not be verified' } })
  equal(observedUnknown.evidence.source_reference.spawn_gen, 'gen-2')
  equal(observedUnknown.evidence.historical_last_event, 'paused')
  equal(previouslyUnknown.event_type, 'worker.current_state.changed')
  deepEqual(previouslyUnknown.change, { field: 'current_state', before: 'unknown', after: 'working' })
  equal(previouslyUnknown.subject.id, entityId('worker', home.id, sample.id, 'gen-2'))
  equal(previouslyUnknown.observation.previous_snapshot, observedUnknown.observation.current_snapshot)
  equal(previouslyUnknown.observation.observed_between.after, at(3))
  equal(newlySeen.event_type, 'worker.observed')
  deepEqual(newlySeen.change, { after: { current_state: 'working' } })
  equal(newlySeen.evidence.confidence_basis, 'first seen after the initial inventory')
  deepEqual([firstDeparture, secondDeparture].map(event => event.evidence.source_reference.spawn_gen), ['gen-1', 'gen-2'])
  ok([firstDeparture, secondDeparture].every(event => event.event_type === 'worker.inventory.left'))
  throws(() => parseWorkers(encodeFleet(at(0), [sample]), home, at(1), at(2)), /outside this collection window/)
})

test('worker membership events require accepted inventories and replay after restart', async t => {
  const path = join(await temp(t), 'journal.sqlite')
  const writer = new Journal(path)
  writer.register(workers)
  const initial = { id: 'initial-worker', gen: 'gen-1', state: 'working' }
  const arriving = { id: 'arriving-worker', gen: 'gen-2', state: 'unknown' }
  equal(writer.record(workerObservation([initial], 0)), 0)
  const [baseline] = writer.sources()
  for (const [minute, health] of [[1, 'partial'], [2, 'unavailable']]) {
    equal(writer.record({ ...workerObservation([arriving], minute), health, inventory_complete: false }), 0)
    equal(writer.sources()[0].last_snapshot_id, baseline.last_snapshot_id)
  }
  writer.close()

  const journal = new Journal(path)
  t.after(() => journal.close())
  equal(journal.record(workerObservation([arriving], 3)), 2)
  equal(journal.record(workerObservation([arriving], 4)), 0)
  const [observed, left] = journal.events()
  equal(observed.event_type, 'worker.observed')
  equal(left.event_type, 'worker.inventory.left')
  deepEqual(left.change, { field: 'inventory_membership', before: 'present', after: 'absent' })
  equal(left.evidence.source_reference.spawn_gen, 'gen-1')
  equal(left.observation.previous_snapshot, baseline.last_snapshot_id)
  equal(left.observation.batch_id, observed.observation.batch_id)
  deepEqual(left.observation.observed_between, { after: at(0), by: at(4) })
  equal(left.occurred_at, null)
  const { stdout: text } = await exec(process.execPath, [cli, 'replay', '--db', path, '--type', 'worker'])
  match(text, /first observed · unknown/)
  match(text, /no longer in the accepted inventory/)
  const { stdout: json } = await exec(process.execPath, [cli, 'replay', '--db', path, '--after', String(observed.sequence), '--json'])
  deepEqual(JSON.parse(json), left)
  equal(journal.record(workerObservation([arriving, initial], 5)), 1)
  const returned = journal.events().at(-1)
  equal(returned.event_type, 'worker.inventory.entered')
  equal(returned.subject.id, left.subject.id)
  deepEqual(returned.change, { field: 'inventory_membership', before: 'absent', after: 'present' })
  equal(journal.record(workerObservation([arriving, initial], 5)), 0)
  equal(journal.record(workerObservation([], 6)), 2)
  equal(journal.record(workerObservation([{ ...initial, state: 'parked' }, { ...arriving, state: 'working' }], 7)), 4)
  deepEqual(journal.events().slice(-4).map(event => [event.event_type, event.change.before, event.change.after]), [
    ['worker.inventory.entered', 'absent', 'present'],
    ['worker.current_state.changed', 'unknown', 'working'],
    ['worker.inventory.entered', 'absent', 'present'],
    ['worker.current_state.changed', 'working', 'parked'],
  ])
  const replay = await exec(process.execPath, [cli, 'replay', '--db', path, '--after', String(left.sequence)])
  match(replay.stdout, /returned to the accepted inventory/)
})

test('verified active worker states advance the journal without trusting historical reports', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.register(workers)
  const worker = { id: 'sample-worker', gen: 'gen-1', source: 'run-step' }
  equal(journal.record(workerObservation([{ ...worker, state: 'parked' }], 0)), 0)
  equal(journal.record(workerObservation([{ ...worker, state: 'running', source: 'status-log' }], 1)), 0)
  equal(journal.record(workerObservation([{ ...worker, state: 'running' }], 2)), 1)
  equal(journal.record(workerObservation([{ ...worker, state: 'executing' }], 3)), 1)
  equal(journal.record(workerObservation([{ ...worker, state: 'waiting', source: 'pane' }], 4)), 1)
  equal(journal.record(workerObservation([{ ...worker, state: 'needs-decision', source: 'pane' }], 5)), 1)
  deepEqual(journal.events().map(event => event.change), [
    { field: 'current_state', before: 'parked', after: 'running' },
    { field: 'current_state', before: 'running', after: 'executing' },
    { field: 'current_state', before: 'executing', after: 'waiting' },
    { field: 'current_state', before: 'waiting', after: 'needs-decision' },
  ])
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
    const [, worker] = await observeHome(fixture, path, { now: () => new Date(at(minute)) })
    return worker
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
  const addMates = (fleet, state) => {
    const worker = fleet.tasks[0]
    fleet.tasks.push(
      { id: 'kind-mate', kind: 'secondmate', remote: null },
      { id: 'role-mate', role: 'secondmate', remote: null },
      { id: 'listed-mate', remote: null },
      { ...worker, id: 'kind-worker', kind: 'secondmate', current_state: { ...worker.current_state, state } },
      { ...worker, id: 'role-worker', role: 'secondmate', current_state: { ...worker.current_state, state } },
      { ...worker, id: 'listed-worker', current_state: { ...worker.current_state, state } },
      { id: 'remote-worker', remote: { host: 'example', root: '/example' } },
    )
    fleet.secondmate_current.records = [{ id: 'listed-mate' }, { id: 'listed-worker' }]
  }
  equal(journal.record(await poll(failures.length, fleet => addMates(fleet, 'working'))), 0)
  deepEqual(journal.recordAttempt(await poll(failures.length + 1, fleet => addMates(fleet, 'parked'))),
    { written: 3, complete: false })
  deepEqual(journal.events().map(event => event.evidence.source_reference.task_id), ['kind-worker', 'listed-worker', 'role-worker'])
  for (const event of journal.events()) {
    deepEqual(event.change, { field: 'current_state', before: 'working', after: 'parked' })
  }
  const [health] = journal.sources()
  equal(health.health, 'partial')
  equal(health.reason, 'some local second mates have no verified spawn generation')
  equal(health.counts.secondmate_without_generation, 3)
  equal(health.counts.current_state_unavailable, 0)

  const loseGenerations = fleet => {
    addMates(fleet, 'working')
    for (const mate of fleet.tasks) {
      if (['kind-worker', 'role-worker', 'listed-worker'].includes(mate.id)) delete mate.spawn_gen
    }
    fleet.tasks = fleet.tasks.filter(task => task.id !== second.id)
  }
  equal(journal.record(await poll(failures.length + 2, loseGenerations)), 1)
  const unrelatedDeparture = journal.events().at(-1)
  equal(unrelatedDeparture.event_type, 'worker.inventory.left')
  equal(unrelatedDeparture.evidence.source_reference.task_id, second.id)
  equal(journal.record(await poll(failures.length + 3, loseGenerations)), 0)
  equal(journal.record(await poll(failures.length + 4, fleet => {
    addMates(fleet, 'working')
    fleet.tasks = fleet.tasks.filter(task => task.id !== second.id && task.id !== 'role-worker')
  })), 3)
  const [kind, listed, role] = journal.events().slice(-3)
  for (const [id, event] of [['kind-worker', kind], ['listed-worker', listed]]) {
    equal(event.event_type, 'worker.current_state.changed')
    equal(event.evidence.source_reference.task_id, id)
    deepEqual(event.change, { field: 'current_state', before: 'parked', after: 'working' })
    equal(event.observation.observed_between.after, at(failures.length + 1))
  }
  equal(role.event_type, 'worker.inventory.left')
  equal(role.evidence.source_reference.task_id, 'role-worker')
  equal(role.observation.previous_snapshot, health.last_snapshot_id)
  equal(role.observation.observed_between.after, at(failures.length + 1))

  const firstAppearance = { id: 'new-mate', kind: 'secondmate', remote: null }
  equal(journal.record(await poll(failures.length + 5, fleet => {
    loseGenerations(fleet)
    fleet.tasks.push(firstAppearance)
  })), 0)
  equal(journal.record(await poll(failures.length + 6, fleet => {
    addMates(fleet, 'working')
    fleet.tasks = fleet.tasks.filter(task => task.id !== second.id)
    fleet.tasks.find(task => task.id === 'role-worker').current_state.state = 'parked'
    fleet.tasks.push({ ...fleet.tasks[0], ...firstAppearance })
  })), 2)
  const arrivals = journal.events().slice(-2)
  deepEqual(arrivals.map(event => event.event_type), ['worker.observed', 'worker.inventory.entered'])
  for (const arrival of arrivals) {
    equal(Object.hasOwn(arrival.observation, 'previous_snapshot'), false)
    deepEqual(arrival.observation.observed_between, { after: null, by: at(failures.length + 6) })
  }
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
  const [baseline] = await observeHome(fixture, path, options(new Date(2026, 0, 1, 23, 59, 20)))
  journal.record(baseline)
  process.env.EVENTS_TEST_DAY = 'new'
  const [cached] = await observeHome(fixture, path, options(new Date(2026, 0, 1, 23, 59, 40)))
  equal(cached.method, 'markdown-fingerprint')
  equal(journal.record(cached), 0)
  let clockReads = 0
  const [after] = await observeHome(fixture, path, {
    taskCache,
    now: () => clockReads++ < 2 ? new Date(2026, 0, 1, 23, 59, 59) : new Date(2026, 0, 2, 0, 0, 0),
  })
  equal(after.method, 'tasks-axi-list')
  equal(journal.record(after), 2)
  deepEqual(journal.events().map(event => event.change), [
    { field: 'held', before: true, after: false },
    { field: 'ready', before: false, after: true },
  ])
  equal((await stat(backlog, { bigint: true })).mtimeNs, fingerprint.mtimeNs)
  equal(await readFile(backlog, 'utf8'), 'Synthetic immutable backlog\n')
})

test('replay preserves ascending order and filters across multiple pages', async t => {
  const path = join(await temp(t), 'journal.sqlite')
  const journal = new Journal(path)
  journal.registerSources([tasks, workers])
  journal.record(taskObservation([], 0))
  journal.record(workerObservation([], 0))
  journal.record(taskObservation(Array.from({ length: 410 }, (_, i) => row(`task-${i}`)), 1))
  journal.record(workerObservation([{ id: 'worker-a', gen: 'gen-1', state: 'working' }], 1))
  journal.close()
  const replay = async args => {
    const { stdout } = await exec(cli, ['replay', '--db', path, '--type', 'task', '--json', ...args])
    return stdout.trim().split('\n').map(line => JSON.parse(line).sequence)
  }
  const expected = Array.from({ length: 405 }, (_, i) => i + 6)
  deepEqual(await replay(['--last', '405']), expected)
  deepEqual(await replay(['--after', '5']), expected)
})

test('watch exits on SIGTERM while stdout is blocked', async t => {
  const path = join(await temp(t), 'journal.sqlite')
  const journal = new Journal(path)
  journal.register(tasks)
  journal.record(taskObservation([], 0))
  journal.record(taskObservation(Array.from({ length: 2000 }, (_, i) => row(`task-${i}`)), 1))
  journal.close()

  const child = spawn(process.execPath, [cli, 'watch', '--db', path, '--after', '0', '--json'])
  const done = new Promise(resolve => {
    child.once('exit', (code, signal) => resolve({ code, signal }))
    child.once('error', error => resolve({ error: error.message }))
  })
  t.after(() => {
    child.kill('SIGKILL')
    return done
  })
  const startup = await Promise.race([
    new Promise(resolve => child.stdout.once('readable', () => {
      resolve(child.stdout.readableLength > 0 ? 'output' : 'stdout ended')
    })),
    done.then(result => `watch exited before output: ${JSON.stringify(result)}`),
    sleep(3000, 'watch produced no output before the startup deadline', { ref: false }),
  ])
  equal(startup, 'output')
  await sleep(200)
  child.kill('SIGTERM')
  deepEqual(await Promise.race([done, sleep(1500, 'still blocked', { ref: false })]), { code: 0, signal: null })
})

test('PR link casing is canonical across both structured inputs', async t => {
  const journal = new Journal(join(await temp(t), 'journal.sqlite'))
  t.after(() => journal.close())
  journal.register(tasks)
  const task = row('sample-task')
  const canonical = 'https://github.com/owner/.github/pull/12'
  journal.record(taskObservation([], 0))
  equal(journal.record(taskObservation([task], 1, tasks, [{
    id: task.id, links: [{ url: 'HTTPS://GitHub.com/Owner/.GitHub/pull/12' }],
  }])), 2)
  deepEqual(journal.events()[1].change.after, [canonical])
  equal(journal.record(taskObservation([task], 2, tasks, [{
    id: task.id, pr_url: 'HtTpS://GITHUB.COM/OWNER/.GITHUB/pull/12',
  }])), 0)
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

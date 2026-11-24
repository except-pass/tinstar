import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { deploymentSource, observeFloor, parseFloorAudit } from '../deployment.js'
import { entityId, sourcesFor } from '../firstmate.js'
import { githubObserver, githubSource } from '../github.js'
import { Journal } from '../journal.js'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../events', import.meta.url))
const pullUrl = 'https://github.com/example/project/pull/12'
const revision = 'a'.repeat(40)
const nextRevision = 'b'.repeat(40)
const at = seconds => new Date(Date.UTC(2026, 0, 1, 12, 0, seconds)).toISOString()

async function journalPath(t) {
  const directory = await mkdtemp(join(tmpdir(), 'event-provider-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return join(directory, 'journal.sqlite')
}

function taskLinks(journal, home, links, second = 0, verified = true) {
  const [source] = sourcesFor(home)
  journal.registerSources([source])
  const entries = Object.keys(links).map(task_id => ({
    id: entityId('task', home.id, task_id), fields: { state: 'queued' },
    evidence: { task_id, state_source: 'tasks-axi' }, related: [],
  }))
  journal.record({
    source, health: 'ok', started_at: at(second), observed_at: at(second + 1), entries,
    pullRequests: verified ? {
      links: new Map(Object.entries(links)),
      started_at: at(second + 1), generated_at: at(second + 2), observed_at: at(second + 3),
    } : null,
  })
}

function pull(fields = {}) {
  return { number: 12, base: { repo: { full_name: 'Example/Project' } }, state: 'open', draft: false,
    updated_at: at(0), merged: false, merge_commit_sha: nextRevision, head: { sha: revision },
    body: 'unrestricted synthetic prose', ...fields }
}

function githubResponse(body, { etag = '"sample"', remaining = '4000', status = 200, extra = [] } = {}) {
  return { status, headers: new Map([['etag', etag], ['x-ratelimit-remaining', remaining], ...extra]), body: JSON.stringify(body) }
}

const openHome = { id: 'example-live', path: '/example/live', mode: 'live' }
const fixtureHome = { id: 'example-fixture', path: '/example/fixture', mode: 'fixture' }
const prCheck = (conclusion = null) => ({
  id: 100, url: 'https://api.github.com/repos/Example/Project/check-runs/100',
  head_sha: revision, conclusion, status: conclusion ? 'completed' : 'in_progress',
})

test('GitHub reads only verified live links, coalesces exact task relationships, and replays immutable observations', async t => {
  const path = await journalPath(t)
  let journal = new Journal(path)
  t.after(() => journal.close())
  journal.registerSources([githubSource])
  taskLinks(journal, openHome, { one: [pullUrl], removed: [pullUrl.replace('/12', '/21')] })
  taskLinks(journal, fixtureHome, { one: [pullUrl] })
  taskLinks(journal, openHome, { one: [pullUrl, 'https://github.com/example/other-project/pull/99'] }, 5)
  const secondary = { ...openHome, id: 'example-secondary', path: '/example/secondary' }
  taskLinks(journal, secondary, { two: [pullUrl] })
  const before = journal.tail()

  let second = 10
  let pr = pull()
  let checks = { total_count: 1, check_runs: [prCheck()] }
  let conditional = false
  const calls = []
  const get = async (path, tag) => {
    calls.push([path, tag])
    if (conditional) return githubResponse(null, { status: 304 })
    return githubResponse(path.includes('/pulls/') ? pr : checks)
  }
  const options = { repositories: ['EXAMPLE/project'], get, now: () => new Date(at(second++)) }
  const observe = githubObserver(options)
  equal(await observe(journal), true)
  deepEqual(calls.map(([endpoint]) => endpoint), [
    'repos/example/project/pulls/12',
    `repos/example/project/commits/${revision}/check-runs?filter=all&per_page=100`,
  ])
  const observed = journal.events({ after: before, provider: 'github' })
  deepEqual(observed.map(event => event.event_type), ['pr.observed', 'pr.checks.observed'])
  equal(observed[0].change.after.merge_sha, null)
  equal(observed[0].change.after.updated_at, undefined)
  deepEqual(observed[0].related, [
    { relation: 'linked-task', subject: { type: 'task', id: entityId('task', openHome.id, 'one') } },
    { relation: 'linked-task', subject: { type: 'task', id: entityId('task', secondary.id, 'two') } },
  ])
  ok(observed.every(event => !JSON.stringify(event).includes(pr.body)))
  conditional = true
  equal(await observe(journal), true)
  deepEqual(calls.slice(2).map(([, etag]) => etag), ['"sample"', '"sample"'])
  deepEqual(journal.events({ after: before, provider: 'github' }), observed)

  taskLinks(journal, secondary, { two: [] }, 5)
  conditional = false
  pr = pull({ state: 'closed', merged: true, updated_at: at(18) })
  checks = { total_count: 1, check_runs: [prCheck('success')] }
  equal(await observe(journal), true)
  const changes = journal.events({ after: observed.at(-1).sequence, provider: 'github' })
  deepEqual(changes.map(event => event.event_type), ['pr.merged', 'pr.updated', 'pr.checks.changed'])
  deepEqual(changes[0].change, { field: 'state', before: 'open', after: 'merged' })
  equal(changes[1].change.after, nextRevision)
  deepEqual(changes[0].related, observed[0].related.slice(0, 1))
  equal(new Set(changes.map(event => event.observation.batch_id)).size, 1)
  ok(changes.every(event => event.occurred_at === null && event.observation.previous_snapshot))

  const beforeTimestampOnly = journal.tail()
  pr.updated_at = at(19)
  equal(await observe(journal), true)
  equal(journal.tail(), beforeTimestampOnly)

  journal.close()
  journal = new Journal(path)
  const resumed = githubObserver(options)
  const cursor = journal.tail()
  equal(await resumed(journal), true)
  equal(journal.tail(), cursor)
  deepEqual(journal.inspect(changes[0].event_id), changes[0])

  pr = pull({ updated_at: at(18) }) // Older upstream data must never undo the accepted merge.
  equal(await resumed(journal), false)
  equal(journal.sources().find(source => source.type === 'pr').health, 'stale')
  equal(journal.tail(), cursor)

  const { stdout } = await exec(cli, ['replay', '--db', path, '--type', 'pr', '--source', 'github', '--entity',
    'github:pr:example/project#12', '--after', String(observed.at(-1).sequence), '--json'])
  deepEqual(stdout.trim().split('\n').map(line => JSON.parse(line)), changes)
  const text = await exec(cli, ['replay', '--db', path, '--type', 'pr', '--last', '1'])
  match(text.stdout, /\[replay\/live\].*in_progress=1 → success=1/)
})

test('GitHub rejects check runs from another repository even when the head matches', async t => {
  const journal = new Journal(await journalPath(t))
  t.after(() => journal.close())
  journal.registerSources([githubSource])
  taskLinks(journal, openHome, { one: [pullUrl] })

  let second = 10
  const observe = githubObserver({
    repositories: ['example/project'],
    now: () => new Date(at(second++)),
    get: async path => githubResponse(path.includes('/pulls/') ? pull() : {
      total_count: 1,
      check_runs: [{ ...prCheck(), url: 'https://api.github.com/repos/other-example/project/check-runs/100' }],
    }),
  })
  equal(await observe(journal), false)
  const events = journal.events({ provider: 'github' })
  deepEqual(events.map(event => event.event_type), ['pr.observed'])
  equal(events[0].evidence.check_coverage, 'unavailable')
})

test('GitHub retains check provenance through a partial merge poll and observes an empty new head', async t => {
  const path = await journalPath(t)
  let journal = new Journal(path)
  t.after(() => journal.close())
  journal.registerSources([githubSource])
  taskLinks(journal, openHome, { one: [pullUrl] })
  let second = 10
  let pr = pull()
  let checks = { total_count: 1, check_runs: [prCheck()] }
  const options = {
    repositories: ['example/project'],
    now: () => new Date(at(second++)),
    get: async path => githubResponse(path.includes('/pulls/') ? pr : checks),
  }
  const observe = githubObserver(options)
  equal(await observe(journal), true)
  const verified = journal.events().at(-1)

  pr = pull({ state: 'closed', merged: true, updated_at: at(20) })
  checks = { total_count: 101, check_runs: [prCheck()] }
  equal(await observe(journal), false)
  const partial = journal.events({ provider: 'github', after: verified.sequence })
  deepEqual(partial.map(event => event.event_type), ['pr.merged', 'pr.updated'])
  equal(partial[0].evidence.check_coverage, 'unavailable')
  equal(journal.sources().find(source => source.type === 'pr').health, 'partial')

  journal.close()
  journal = new Journal(path)
  const resumed = githubObserver(options)
  checks = { total_count: 1, check_runs: [prCheck('success')] }
  equal(await resumed(journal), true)
  const recovered = journal.events().at(-1)
  equal(recovered.event_type, 'pr.checks.changed')
  equal(recovered.observation.previous_snapshot, verified.observation.current_snapshot)
  pr = { ...pr, head: { sha: nextRevision }, updated_at: at(30) }
  checks = { total_count: 0, check_runs: [] }
  equal(await resumed(journal), true)
  const empty = journal.events().at(-1)
  equal(empty.event_type, 'pr.checks.observed')
  deepEqual(empty.change, { field: 'checks', after: [] })
  equal(empty.observation.previous_snapshot, undefined)
  equal(await resumed(journal), true)
  equal(journal.tail(), empty.sequence)
})

test('GitHub rechecks links after awaits and resolves associations at append time', async t => {
  const journal = new Journal(await journalPath(t))
  t.after(() => journal.close())
  journal.registerSources([githubSource])
  const otherPull = pullUrl.replace('/12', '/13')
  taskLinks(journal, openHome, { one: [pullUrl, otherPull] })
  let second = 10
  let phase = 0
  const calls = []
  const observe = githubObserver({
    repositories: ['example/project'],
    now: () => new Date(at(second++)),
    get: async path => {
      calls.push(path)
      if (phase === 0) {
        taskLinks(journal, openHome, { one: [] }, 5)
        return githubResponse(pull())
      }
      if (path.includes('/pulls/')) return githubResponse(pull({ draft: true, updated_at: at(20) }))
      taskLinks(journal, openHome, { one: [], two: [pullUrl] }, 15)
      return githubResponse({ total_count: 0, check_runs: [] })
    },
  })
  equal(await observe(journal), false)
  deepEqual(calls, ['repos/example/project/pulls/12'])
  deepEqual(journal.events({ provider: 'github' }).at(-1).related, [])
  phase++
  taskLinks(journal, openHome, { one: [pullUrl] }, 10)
  equal(await observe(journal), true)
  for (const event of journal.events({ provider: 'github' }).slice(1)) {
    deepEqual(event.related, [{ relation: 'linked-task', subject: { type: 'task', id: entityId('task', openHome.id, 'two') } }])
  }
})

test('GitHub distinguishes an empty verified backlog from incomplete discovery', async t => {
  const journal = new Journal(await journalPath(t))
  t.after(() => journal.close())
  journal.registerSources([githubSource])
  taskLinks(journal, openHome, {})
  let second = 10
  let calls = 0
  const observe = githubObserver({
    repositories: ['example/project'],
    now: () => new Date(at(second++)),
    get: async path => {
      calls++
      return githubResponse(path.includes('/pulls/') ? pull() : { total_count: 0, check_runs: [] })
    },
  })
  const health = () => journal.sources().find(source => source.type === 'pr').health
  equal(await observe(journal), true)
  equal(health(), 'unconnected')
  const [source] = sourcesFor(openHome)
  journal.record({ source, health: 'unavailable', started_at: at(5), observed_at: at(6) })
  equal(await observe(journal), false)
  equal(health(), 'unavailable')
  equal(calls, 0)
  const other = { ...openHome, id: 'example-other', path: '/example/other' }
  taskLinks(journal, other, { two: [pullUrl] })
  equal(await observe(journal), false)
  equal(health(), 'partial')
  equal(calls, 2)
  taskLinks(journal, openHome, { one: [pullUrl.replace('/12', '/13')] }, 10)
  taskLinks(journal, openHome, { one: [] }, 15, false)
  equal(await observe(journal), false)
  equal(health(), 'partial')
  equal(calls, 4)
})

test('text replay identifies checks that swap outcomes with unchanged totals', async t => {
  const path = await journalPath(t)
  const journal = new Journal(path)
  t.after(() => journal.close())
  journal.registerSources([githubSource])
  taskLinks(journal, openHome, { one: [pullUrl] })
  let second = 10
  let swapped = false
  const observe = githubObserver({
    repositories: ['example/project'],
    now: () => new Date(at(second++)),
    get: async endpoint => githubResponse(endpoint.includes('/pulls/') ? pull() : {
      total_count: 2,
      check_runs: [prCheck(swapped ? 'failure' : 'success'), {
        ...prCheck(swapped ? 'success' : 'failure'), id: 101,
        url: 'https://api.github.com/repos/Example/Project/check-runs/101',
      }],
    }),
  })
  equal(await observe(journal), true)
  swapped = true
  equal(await observe(journal), true)
  const { stdout } = await exec(cli, ['replay', '--db', path, '--type', 'pr', '--last', '1'])
  match(stdout, /#100 completed\/success → completed\/failure, #101 completed\/failure → completed\/success/)
})

test('GitHub rotates bounded pulls and stops at the shared reserve', async t => {
  const journal = new Journal(await journalPath(t))
  t.after(() => journal.close())
  journal.registerSources([githubSource])
  taskLinks(journal, openHome, { one: Array.from({ length: 5 }, (_, i) => pullUrl.replace('/12', `/${12 + i}`)) })
  let second = 70
  let remaining = '4000'
  let requests = 0
  const observe = githubObserver({
    repositories: ['example/project'],
    now: () => new Date(at(second++)),
    get: async path => {
      requests++
      const number = Number(path.split('/').at(-1))
      const body = path.includes('/pulls/') ? pull({ number }) : { total_count: 0, check_runs: [] }
      return githubResponse(body, { remaining })
    },
  })
  equal(await observe(journal), false)
  equal(requests, 8)
  deepEqual(journal.sources().find(source => source.type === 'pr').counts, { linked: 5, observed: 4, failed: 0, deferred: 1, checks_unavailable: 0 })
  equal(journal.events({ provider: 'github' }).at(-1).evidence.source_reference.number, 15)
  equal(await observe(journal), false)
  equal(requests, 16)
  equal(journal.events({ provider: 'github' }).at(-1).evidence.source_reference.number, 16)
  remaining = '1000'
  const before = journal.tail()
  equal(await observe(journal), false)
  equal(await observe(journal), false)
  equal(requests, 17)
  equal(journal.tail(), before)
  match(journal.sources().find(source => source.type === 'pr').reason, /quota reserve/)
})

test('First Mate configuration leaves GitHub and deployment unconnected without opt-ins', async t => {
  const path = await journalPath(t)
  const journal = new Journal(path)
  journal.registerSources([githubSource])
  journal.close()

  const config = join(path, '..', 'config.json')
  const homes = [{ id: 'example-unavailable', path: join(path, '..', 'missing-home') }]
  for (const options of [{}, { github: { repositories: [] } }]) {
    await writeFile(config, JSON.stringify({ homes, ...options }))
    await rejects(exec(cli, ['observe', '--db', path, '--config', config]), { code: 1 })
    const { stdout } = await exec(cli, ['sources', '--db', path])
    match(stdout, /github:linked-pulls unconnected/)
    match(stdout, /deployment:tinstar-floor:.* unconnected · Tin Star floor running revision/)
  }
})

test('the GitHub configuration rejects owner-wide allowlist entries', async t => {
  const path = await journalPath(t)
  const config = join(path, '..', 'config.json')
  await writeFile(config, JSON.stringify({
    homes: [{ id: 'example-unavailable', path: join(path, '..', 'missing-home') }],
    github: { repositories: ['example/*'] },
  }))
  await rejects(exec(cli, ['observe', '--db', path, '--config', config]), {
    stderr: /github\.repositories must list exact owner\/repo entries/,
  })
})

test('deployment parser projects synthetic audit receipts and a failure marker', async () => {
  const [audit, failureMarker] = await Promise.all([
    readFile(new URL('./fixtures/deployment-audit.synthetic.jsonl', import.meta.url), 'utf8'),
    readFile(new URL('./fixtures/deployment-failure.synthetic.txt', import.meta.url), 'utf8'),
  ])
  const target = 'fixture-floor'
  const events = parseFloorAudit(audit + audit, { target, failureMarker })
  deepEqual(events.map(event => event.event_type), [
    'deployment.started', 'deployment.completed', 'deployment.started',
    'deployment.failed', 'deployment.block_bypassed', 'deployment.block_cleared',
  ])
  equal(events[0].id, events[1].id)
  equal(events[0].fields.previous_revision, nextRevision)
  equal(events[1].fields.revision, revision)
  equal(events[1].fields.native_deployment_id, `floor:${revision}`)
  equal(events[3].fields.revision, 'c'.repeat(40))
  equal(events[3].fields.native_deployment_id, null)
  equal(events[3].occurredAt, '2026-01-01T00:03:00.000Z')
  equal(events[5].fields.revision, null)
  equal(events[5].fields.checkout_revision, revision)
  ok(events.every(event => event.evidence.source_reference.target === target))
  ok(!/synthetic-user|synthetic operator reason|synthetic receipt|github[.]com/.test(JSON.stringify(events)))
  deepEqual(parseFloorAudit('bad JSON\n{"action":"floor-smoke","passed":true}', { target }), [])
})

test('deployment observes an exact running build through outages and restart without asserting ancestry or lifecycle transitions', async t => {
  const path = await journalPath(t)
  let journal = new Journal(path)
  t.after(() => journal.close())
  journal.registerSources([deploymentSource])
  let second = 0
  let sha = revision
  const options = {
    now: () => new Date(at(second++)),
    fetchFloor: async (url, options) => {
      equal(url, 'http://127.0.0.1:5281/api/deployment')
      equal(options.redirect, 'error')
      return Response.json({ ok: true, data: { sha, pr: pullUrl } })
    },
  }
  equal(await observeFloor(journal, undefined, options), true)
  const [first] = journal.events()
  deepEqual(first.change.after, { environment: 'floor', lifecycle: 'running', revision, native_deployment_id: null })
  deepEqual(first.related, [])
  ok(!JSON.stringify(first).includes(pullUrl))
  sha = null
  equal(await observeFloor(journal, undefined, options), false)
  equal(journal.tail(), first.sequence)
  equal(journal.sources()[0].last_success_at, first.observed_at)

  journal.close()
  journal = new Journal(path)
  sha = nextRevision
  equal(await observeFloor(journal, undefined, options), true)
  equal(await observeFloor(journal, undefined, options), true)
  const [change] = journal.events({ after: first.sequence, type: 'deployment' })
  equal(change.event_type, 'deployment.revision.changed')
  deepEqual(change.related, [])
  equal(change.occurred_at, null)
  deepEqual(change.change, { field: 'revision', before: revision, after: nextRevision })
  equal(change.observation.previous_snapshot, first.observation.current_snapshot)
  const { stdout } = await exec(cli, ['replay', '--db', path, '--source', 'deployment', '--type', 'deployment', '--after', '0', '--json'])
  deepEqual(stdout.trim().split('\n').map(line => JSON.parse(line)), [first, change])
  const detail = await exec(cli, ['inspect', '--db', path, change.event_id])
  deepEqual(JSON.parse(detail.stdout), change)
  const status = await exec(cli, ['sources', '--db', path])
  match(status.stdout, /deployment:.* ok · Tin Star floor running revision/)
  match(status.stdout, /deployment:lifecycle unconnected · deployment attempts, smoke, failure and rollback/)
  match(status.stdout, /github:linked-pulls unconnected/)
  match(status.stdout, /jira:ticket unconnected/)
})

test('provider snapshots roll back together when an event append fails', async t => {
  const path = await journalPath(t)
  const journal = new Journal(path)
  t.after(() => journal.close())
  journal.registerSources([githubSource])
  taskLinks(journal, openHome, { one: [pullUrl] })
  let second = 10
  const observe = githubObserver({
    repositories: ['example/project'],
    now: () => new Date(at(second++)),
    get: async path => githubResponse(path.includes('/pulls/') ? pull() : { total_count: 1, check_runs: [prCheck()] }),
  })
  journal.db.exec(`CREATE TRIGGER stop_checks BEFORE INSERT ON events
    WHEN json_extract(NEW.envelope, '$.event_type') = 'pr.checks.observed'
    BEGIN SELECT RAISE(ABORT, 'synthetic append failure'); END`)
  await rejects(observe(journal), /synthetic append failure/)
  equal(journal.tail(), 0)
  equal(journal.sources().find(source => source.type === 'pr').last_snapshot_id, null)
  journal.db.exec('DROP TRIGGER stop_checks')
  equal(await observe(journal), true)
  equal(journal.tail(), 2)
})

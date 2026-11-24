import { deepEqual, equal, match, rejects } from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { githubReader } from '../github.js'
import { Journal } from '../journal.js'
import { releaseTagObserver, tagRepository, tagSource } from '../releaseTags.js'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../events', import.meta.url))
const check = fileURLToPath(new URL('../cmsandbox-tag-wake.check.sh', import.meta.url))
const head = 'a'.repeat(40)
const moved = 'b'.repeat(40)
const old = 'c'.repeat(40)
const row = (name, sha = head) => ({ name, commit: { sha } })
const github = (body, { status = 200, remaining = '4000', extra = [] } = {}) => ({
  status, headers: new Map([['x-ratelimit-remaining', remaining], ['etag', '"test"'], ...extra]), body: JSON.stringify(body),
})

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'release-tags-'))
  const path = join(dir, 'journal.sqlite')
  let journal = new Journal(path)
  t.after(async () => {
    journal.close()
    await rm(dir, { recursive: true, force: true })
  })
  let time = Date.UTC(2026, 5, 1)
  const now = () => new Date(time)
  return {
    dir, path, now,
    poll: observe => { time += 120_000; return observe(journal) },
    events: () => journal.events({ type: 'tag' }),
    source: () => journal.sources().find(source => source.source_id === tagSource.source_id),
    register: () => journal.registerSources([tagSource]),
    reopen() { journal.close(); journal = new Journal(path); this.register() },
  }
}

test('cmsandbox poll baselines existing tags silently, keeps ref transitions and dedupes moved and restored identities across restart', async t => {
  const fixture = await setup(t)
  fixture.register()
  let pages = [
    [row('v1.9.0', old), row('v1.100.0-rc.1'), ...Array.from({ length: 98 }, (_, i) => row(`scratch-${i}`))],
    [row('v1.10.0')],
  ]
  let failed = false
  let cached = false
  const get = async (endpoint, etag) => {
    const page = Number(new URL(endpoint, 'https://api.github.com/').searchParams.get('page'))
    if (failed && page === 2) return github(null, { status: 503 })
    if (cached && etag === '"test"') return github(null, { status: 304 })
    return github(pages[page - 1] ?? [])
  }
  const observe = () => releaseTagObserver({ reader: githubReader({ get, now: fixture.now }), now: fixture.now,
    fetchEndpoint: async () => new Response(null, { status: 503 }) })
  let poll = observe()
  equal(await fixture.poll(poll), true)
  deepEqual(fixture.events(), [])

  cached = true
  await fixture.poll(poll)
  deepEqual(fixture.events(), [])
  cached = false
  fixture.reopen()
  poll = observe()
  await fixture.poll(poll)
  deepEqual(fixture.events(), [])

  pages[1] = [row('v1.10.0', moved), row('v1.11.0')]
  await fixture.poll(poll)
  pages[1] = [row('v1.10.0'), row('v1.11.0')]
  await fixture.poll(poll)
  pages[1] = [row('v1.10.0', moved), row('v1.11.0')]
  await fixture.poll(poll)
  const events = fixture.events()
  const created = events.find(event => event.evidence.source_reference.tag === 'v1.11.0')
  const [move, firstReturn, returned] = events.filter(event => event.evidence.source_reference.tag === 'v1.10.0')
  deepEqual(created.evidence.source_reference, { repository: tagRepository, tag: 'v1.11.0', sha: head })
  equal(created.evidence.action, 'created')
  equal(move.evidence.action, 'moved')
  deepEqual(move.change, { field: 'sha', before: head, after: moved })
  equal(firstReturn.event_type, 'tag.pushed')
  equal(returned.event_type, 'tag.ref.changed')
  equal(returned.evidence.push_event_id, move.event_id)

  pages[1] = [row('v1.11.0')]
  failed = true
  equal(await fixture.poll(poll), false)
  equal(await fixture.poll(poll), false)
  equal(fixture.source().health, 'unavailable')
  equal(fixture.events().length, 4)
  failed = false
  await fixture.poll(poll)
  equal(fixture.events().length, 4)
  fixture.reopen()
  await fixture.poll(observe())
  const deleted = fixture.events().at(-1)
  equal(deleted.event_type, 'tag.deleted')
  deepEqual(deleted.change, { field: 'sha', before: moved, after: null })
  pages[1].push(row('v1.10.0', moved))
  await fixture.poll(observe())
  const restored = fixture.events().at(-1)
  equal(restored.event_type, 'tag.ref.changed')
  equal(restored.evidence.action, 'restored')
  equal(fixture.events().filter(event => event.event_type === 'tag.pushed').length, 3)
})

test('a limited or overlapping inventory cannot establish a baseline or delete tags', async t => {
  const fixture = await setup(t)
  fixture.register()
  let calls = 0
  const first = [row('v1.2.3'), ...Array.from({ length: 99 }, (_, i) => row(`scratch-${i}`))]
  const get = async (_, __) => {
    calls++
    return calls === 1 ? github(first, { remaining: '999', extra: [['x-ratelimit-reset', String(fixture.now().getTime() / 1000 + 600)]] }) :
      github(calls === 2 ? first : [row('v1.2.3', moved)])
  }
  const poll = releaseTagObserver({ reader: githubReader({ get, now: fixture.now }), now: fixture.now })
  equal(await fixture.poll(poll), false)
  match(fixture.source().reason, /quota reserve/)
  equal(calls, 1)
  equal(await fixture.poll(poll), false)
  equal(calls, 1)
  const restarted = releaseTagObserver({ reader: githubReader({ get, now: fixture.now }), now: fixture.now })
  equal(await fixture.poll(restarted), false)
  match(fixture.source().reason, /tag pages overlapped/)
  deepEqual(fixture.events(), [])
})

test('exact-SHA Releases evidence follows the base push and the Main check emits pushes only once', async t => {
  const fixture = await setup(t)
  fixture.register()
  const version = 'v2.1.0'
  const url = `https://github.com/${tagRepository}`
  const cardId = '7'.repeat(32)
  const pull = (number, fields = {}) => ({ url: `${url}/pull/${number}`, state: 'merged', freshness: 'fresh', mergeSha: old,
    links: [{ cardId, active: true }], ...fields })
  const run = (id, fields = {}) => ({ id, url: `${url}/actions/runs/${id}`, sha: head,
    status: 'in_progress', workflow: '.github/workflows/component.yml', attempt: 1, conclusion: null, ...fields })
  const release = {
    repository: tagRepository, version, sourceSha: moved, kind: 'production', membership: { status: 'complete' },
    pulls: [pull(1), pull(2, { freshness: 'stale' })],
    containedPulls: [{ pull: pull(3).url, mergeSha: old, state: 'included' }, { pull: pull(4).url, mergeSha: moved, state: 'included' }],
    github: { runsStatus: 'fresh', runs: [run(4), run(5, { sha: moved }), run(6, { url: `${url}/actions/runs/7` })] },
  }
  let tags = [row('v2.0.0', old)]
  let associationsComplete = true
  let releasesUnavailable = false
  let inventoryUnavailable = false
  let associatedPulls = [pull(1), pull(3), pull(4), pull(7, { exceptions: [`Linked card unavailable: ${cardId}`] })]
  release.pulls.push(pull(8))
  associatedPulls.push(pull(8, { exceptions: [`Linked card unavailable: ${cardId}`] }))
  release.containedPulls.push({ pull: pull(7).url, mergeSha: old, state: 'included' })
  release.github.runsStatus = 'unknown'

  const ssh = join(fixture.dir, 'ssh')
  await writeFile(ssh, `#!/bin/bash
if [[ \$FAIL_SSH ]]; then exit 255; fi
run_remote() {
  [[ \$3 == --db && \$4 == /home/farm/srv/event-publisher/data/journal.sqlite ]] || exit 2
  "\$1" "\$2" "\$3" "\$FIXTURE_DB" "\${@:5}"
}
eval "run_remote \${@: -1}"
`, { mode: 0o700 })
  const cursor = join(fixture.dir, 'cursor')
  const env = { ...process.env, PATH: `${fixture.dir}:${process.env.PATH}`, TAG_WAKE_CURSOR: cursor,
    TAG_WAKE_REMOTE_EVENTS: cli, TAG_WAKE_REMOTE_DB: '', FIXTURE_DB: fixture.path }
  const observer = releaseTagObserver({
    reader: githubReader({ get: async () => inventoryUnavailable ? github(null, { status: 503 }) : github(tags) }), now: fixture.now,
    fetchEndpoint: async endpoint => {
      equal(endpoint.searchParams.get('tag'), version)
      equal(fixture.events()[0].label, 'tag pushed')
      if (releasesUnavailable) return new Response(null, { status: 503 })
      return Response.json({ ok: true, data: { releases: [release], releaseSource: { status: 'partial' },
        associationsComplete, pulls: associatedPulls } })
    },
  })
  await fixture.poll(observer)
  equal((await exec(check, [], { env })).stdout, '')
  fixture.reopen()
  await fixture.poll(observer)
  equal((await exec(check, [], { env })).stdout, '')
  tags.push(row(version))
  await fixture.poll(observer)
  const [push] = fixture.events()
  equal(push.occurred_at, null)
  equal(push.observed_at, fixture.now().toISOString())
  equal(fixture.events().length, 1)
  release.sourceSha = head
  inventoryUnavailable = true
  equal(await fixture.poll(observer), false)
  equal(fixture.source().health, 'unavailable')
  inventoryUnavailable = false
  const evidence = fixture.events().at(-1)
  equal(evidence.event_type, 'tag.evidence.updated')
  equal(evidence.evidence.push_event_id, push.event_id)
  deepEqual(evidence.change.after.pulls.items, [
    { url: pull(1).url, merge_sha: old, basis: 'range' },
    { url: pull(3).url, merge_sha: old, basis: 'ancestry' },
    { url: pull(8).url, merge_sha: old, basis: 'range' },
  ])
  deepEqual(evidence.change.after.cards.items.map(card => card.url), [
    `https://www.notion.so/${cardId}`, `https://www.notion.so/${cardId}`,
  ])
  deepEqual(evidence.change.after.runs.items.map(({ id, status, freshness }) => [id, status, freshness]),
    [[4, 'in_progress', 'last_known']])
  fixture.reopen()
  await fixture.poll(observer)
  deepEqual(fixture.events(), [push, evidence])

  associationsComplete = false
  release.membership.status = 'pending'
  release.pulls = [pull(9)]
  release.github.runs = [run(10)]
  await fixture.poll(observer)
  const partial = fixture.events().at(-1).change.after
  equal(partial.pulls.coverage, 'pending')
  deepEqual(partial.pulls.items.map(item => item.url), [1, 3, 8, 9].map(number => pull(number).url))
  equal(partial.cards.coverage, 'unknown')
  deepEqual(partial.cards.items, evidence.change.after.cards.items)
  equal(partial.runs.coverage, 'unknown')
  deepEqual(partial.runs.items.map(item => item.id), [4, 10])

  associationsComplete = true
  associatedPulls = [pull(1, { exceptions: [`Linked card unavailable: ${cardId}`] }), pull(3), pull(4)]
  release.containedPulls = []
  release.membership.status = 'complete'
  await fixture.poll(observer)
  const retired = fixture.events().at(-1).change.after.cards
  equal(retired.coverage, 'partial')
  deepEqual(retired.items.map(item => item.pull), [pull(3).url])

  associatedPulls = [pull(9, { exceptions: [`Linked card unavailable: ${cardId}`] })]
  release.github.runsStatus = 'fresh'
  await fixture.poll(observer)
  const corrected = fixture.events().at(-1).change.after
  deepEqual(corrected.pulls, { coverage: 'complete', items: [{ url: pull(9).url, merge_sha: old, basis: 'range' }] })
  deepEqual(corrected.cards, { coverage: 'complete', items: [] })
  deepEqual(corrected.runs.items.map(({ id, freshness }) => [id, freshness]), [[10, 'fresh']])

  inventoryUnavailable = true
  releasesUnavailable = true
  equal(await fixture.poll(observer), false)
  equal(fixture.source().health, 'unavailable')
  inventoryUnavailable = false
  const unavailable = fixture.events().at(-1).change.after
  deepEqual(unavailable.pulls, corrected.pulls)
  deepEqual(unavailable.cards, corrected.cards)
  deepEqual(unavailable.runs, { coverage: 'unknown', items: [{ ...corrected.runs.items[0], freshness: 'last_known' }] })

  releasesUnavailable = false
  release.github.runs = []
  await fixture.poll(observer)
  deepEqual(fixture.events().at(-1).change.after.runs, { coverage: 'complete', items: [] })
  release.github.runs = [run(11)]
  await fixture.poll(observer)
  deepEqual(fixture.events().at(-1).change.after.runs.items.map(item => item.id), [11])

  tags = [row('v2.0.0', old)]
  await fixture.poll(observer)
  await fixture.poll(observer)
  const last = fixture.events().at(-1)
  equal(last.event_type, 'tag.deleted')

  const first = await exec(check, [], { env })
  equal(first.stdout, `tag pushed ${tagRepository} ${version} ${head} ${push.observed_at} created #${push.sequence}\n`)
  equal(await readFile(cursor, 'utf8'), `${last.sequence}\n`)
  equal((await exec(check, [], { env })).stdout, '')
  await rejects(exec(check, [], { env: { ...env, FAIL_SSH: '1' } }), { code: 1, stdout: '' })
  equal(await readFile(cursor, 'utf8'), `${last.sequence}\n`)
})

test('shared GitHub reader uses status and headers for backoff', async () => {
  for (const [status, extra, backoff] of [[403, [], false], [403, [['retry-after', '60']], true], [429, [], true]]) {
    let calls = 0
    const reader = githubReader({ get: async () => ++calls === 1
      ? github({ message: 'secondary rate limit' }, { status, extra })
      : github([]) })
    const read = () => reader.sample('tags', undefined, value => value)
    await rejects(read(), backoff ? /back off/ : /HTTP 403/)
    if (backoff) await rejects(read(), /back off/)
    else deepEqual((await read()).value, [])
    equal(calls, backoff ? 1 : 2)
  }
})

test('overlapping GitHub responses keep the longest backoff and its reason', async () => {
  const retry = github(null, { status: 429, extra: [['retry-after', '3600']] })
  const quota = github(null, { status: 403, remaining: '999', extra: [['x-ratelimit-reset', '600']] })
  for (const responses of [[retry, quota], [quota, retry]]) {
    const requests = []
    let time = 0
    const reader = githubReader({
      now: () => new Date(time),
      get: () => new Promise(resolve => requests.push(resolve)),
    })
    const read = path => reader.sample(path, undefined, value => value)
    const pending = [read('tags'), read('pulls')]
    requests[0](responses[0])
    await rejects(pending[0], responses[0] === retry ? /back off/ : /quota reserve/)
    requests[1](responses[1])
    await rejects(pending[1], /back off/)
    time = 900_000
    equal(reader.deferred(), 'GitHub asked the observer to back off')
    await rejects(read('tags'), /back off/)
    equal(requests.length, 2)
    time = 3_600_000
    equal(reader.deferred(), null)
  }
})

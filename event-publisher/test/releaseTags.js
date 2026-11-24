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

test('cmsandbox poll seeds only the newest tag, keeps ref transitions and dedupes moved and restored identities across restart', async t => {
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
  const [seed] = fixture.events()
  deepEqual(seed.evidence.source_reference, { repository: tagRepository, tag: 'v1.10.0', sha: head })
  equal(seed.evidence.action, 'seeded')
  equal(seed.label, 'tag pushed')
  equal(seed.occurred_at, null)
  equal(seed.observed_at, fixture.now().toISOString())

  cached = true
  await fixture.poll(poll)
  deepEqual(fixture.events(), [seed])
  cached = false
  fixture.reopen()
  poll = observe()
  await fixture.poll(poll)
  deepEqual(fixture.events(), [seed])

  pages[1] = [row('v1.10.0', moved), row('v1.11.0')]
  await fixture.poll(poll)
  pages[1] = [row('v1.10.0'), row('v1.11.0')]
  await fixture.poll(poll)
  const [, created, move, returned] = fixture.events()
  deepEqual(created.evidence.source_reference, { repository: tagRepository, tag: 'v1.11.0', sha: head })
  equal(created.evidence.action, 'created')
  equal(move.evidence.action, 'moved')
  deepEqual(move.change, { field: 'sha', before: head, after: moved })
  equal(returned.event_type, 'tag.ref.changed')
  equal(returned.evidence.push_event_id, seed.event_id)

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
  deepEqual(deleted.change, { field: 'sha', before: head, after: null })
  pages[1].push(row('v1.10.0'))
  await fixture.poll(observe())
  const restored = fixture.events().at(-1)
  equal(restored.event_type, 'tag.ref.changed')
  equal(restored.evidence.action, 'restored')
  equal(fixture.events().filter(event => event.event_type === 'tag.pushed').length, 3)
})

test('a limited or overlapping inventory cannot seed or delete tags', async t => {
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
    github: { runsStatus: 'fresh', runs: [run(4), run(5, { sha: moved }), run(6, { workflow: '.github/workflows/release-production.yml' })] },
  }
  let tags = [row(version)]
  const observer = releaseTagObserver({
    reader: githubReader({ get: async () => github(tags) }), now: fixture.now,
    fetchEndpoint: async endpoint => {
      equal(endpoint.searchParams.get('tag'), version)
      equal(fixture.events()[0].label, 'tag pushed')
      return Response.json({ ok: true, data: { releases: [release], releaseSource: { status: 'partial' },
        associationsComplete: true, pulls: [pull(3), pull(4)] } })
    },
  })
  await fixture.poll(observer)
  const [seed] = fixture.events()
  equal(fixture.events().length, 1)
  release.sourceSha = head
  await fixture.poll(observer)
  const evidence = fixture.events().at(-1)
  equal(evidence.event_type, 'tag.evidence.updated')
  equal(evidence.evidence.push_event_id, seed.event_id)
  deepEqual(evidence.change.after.pulls.items, [
    { url: pull(1).url, merge_sha: old, basis: 'range' },
    { url: pull(3).url, merge_sha: old, basis: 'ancestry' },
  ])
  deepEqual(evidence.change.after.cards.items.map(card => card.url), [
    `https://www.notion.so/${cardId}`, `https://www.notion.so/${cardId}`,
  ])
  deepEqual(evidence.change.after.runs.items.map(({ id, status }) => [id, status]), [[4, 'in_progress']])
  fixture.reopen()
  await fixture.poll(observer)
  deepEqual(fixture.events(), [seed, evidence])

  tags = [row(version, moved)]
  await fixture.poll(observer)
  const next = fixture.events().at(-1)
  equal(next.event_type, 'tag.pushed')
  equal(next.evidence.action, 'moved')
  tags = []
  await fixture.poll(observer)
  await fixture.poll(observer)
  const last = fixture.events().at(-1)
  equal(last.event_type, 'tag.deleted')

  const ssh = join(fixture.dir, 'ssh')
  await writeFile(ssh, '#!/bin/bash\nif [[ ${FAIL_SSH:-} ]]; then exit 255; fi\nexec /bin/bash -c "${@: -1}"\n', { mode: 0o700 })
  const cursor = join(fixture.dir, 'cursor')
  const env = { ...process.env, PATH: `${fixture.dir}:${process.env.PATH}`, TAG_WAKE_CURSOR: cursor,
    TAG_WAKE_REMOTE_EVENTS: cli, TAG_WAKE_REMOTE_DB: fixture.path }
  const first = await exec(check, [], { env })
  equal(first.stdout, [
    `tag pushed ${tagRepository} ${version} ${head} ${seed.observed_at} seeded #${seed.sequence}`,
    `tag pushed ${tagRepository} ${version} ${moved} ${next.observed_at} moved #${next.sequence}`,
    '',
  ].join('\n'))
  equal(await readFile(cursor, 'utf8'), `${last.sequence}\n`)
  equal((await exec(check, [], { env })).stdout, '')
  await rejects(exec(check, [], { env: { ...env, FAIL_SSH: '1' } }), { code: 1, stdout: '' })
  equal(await readFile(cursor, 'utf8'), `${last.sequence}\n`)
})

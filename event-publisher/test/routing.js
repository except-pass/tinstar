import { deepEqual, equal, match, rejects } from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Journal } from '../journal.js'

const exec = promisify(execFile)
const cli = fileURLToPath(new URL('../events', import.meta.url))
const fixture = {
  mate_id: 'controlled-hulk-worker',
  old: { machine: 'Hulk', runtime: 'Cursor', provider: 'Grok' },
  new: { machine: 'Hulk', runtime: 'Codex', provider: 'OpenAI' },
  effective_start_at: '2026-11-23T19:34Z',
  recorded_by: 'event-publisher-test',
  source_reference: 'controlled proof',
  controlled: true,
}
const cutover = '2026-11-23T19:34:00.000Z'

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'event-publisher-routing-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const db = join(directory, 'journal.sqlite')
  const run = (...args) => exec(process.execPath, [cli, '--db', db, ...args])
  let inputNumber = 0
  const record = async fields => {
    const path = join(directory, `receipt-${++inputNumber}.json`)
    await writeFile(path, JSON.stringify({ ...fixture, ...fields }))
    return JSON.parse((await run('record-migration', path)).stdout)
  }
  return { db, directory, run, record }
}

test('controlled migration receipt is durable and retries preserve original provenance', async t => {
  const { db, run, record } = await setup(t)
  await rejects(record({ effective_start_at: '2026-11-31T19:34Z' }), error => {
    equal(error.code, 2)
    match(error.stderr, /effective_start_at/)
    return true
  })
  const receipt = await record()
  const retries = await Promise.all([
    record({ recorded_by: 'retry', effective_start_at: '2026-11-23T14:34:00-05:00' }),
    record({ source_reference: 'retry', new: { provider: 'OpenAI', machine: 'Hulk', runtime: 'Codex' } }),
  ])
  deepEqual(retries, [receipt, receipt])
  equal(receipt.event_type, 'mate.migration.recorded')
  equal(receipt.schema, 'event-publisher.event.v1')
  equal(receipt.source.mode, 'fixture')
  equal(receipt.subject.id, fixture.mate_id)
  equal(receipt.effective_start_at, cutover)
  equal(receipt.occurred_at, cutover)
  match(receipt.observed_at, /Z$/)
  deepEqual(receipt.change, { field: 'routing_context', before: fixture.old, after: fixture.new })
  deepEqual(receipt.evidence.source_reference, {
    interface: 'events record-migration', reference: 'controlled proof', recorded_by: fixture.recorded_by,
  })
  const journal = new Journal(db)
  try {
    journal.registerSources([], { reconcile: true })
  } finally {
    journal.close()
  }
  match((await run('sources')).stdout, /routing:mate-migration ok .*last recorded migration/)
  deepEqual(JSON.parse((await run('inspect', receipt.event_id)).stdout), receipt)
  const { stdout } = await run('replay', '--source', 'routing', '--type', 'mate', '--entity', fixture.mate_id, '--after', '0', '--json')
  deepEqual(stdout.trim().split('\n').map(JSON.parse), [receipt])
  match((await run('replay', '--source', 'routing', '--last', '1')).stdout, /controlled proof.*Cursor\/Grok → Hulk\/Codex\/OpenAI/)
})

test('routing metrics keep observations within any visit to the exact route', async t => {
  const { db, directory, record, run } = await setup(t)
  const preciseCutover = '2026-11-23T19:34:00.000004Z'
  const receipt = await record({ effective_start_at: preciseCutover })
  const returningMate = 'controlled-returning-worker'
  const returnReceipt = await record({ mate_id: returningMate, effective_start_at: '2026-11-23T12:00Z' })
  await record({ mate_id: returningMate, effective_start_at: '2026-11-23T10:00Z' })
  await record({
    mate_id: returningMate, effective_start_at: '2026-11-23T11:00Z',
    old: fixture.new, new: fixture.old,
  })
  const observation = {
    observation_id: 'late-replay',
    mate_id: fixture.mate_id,
    route: fixture.new,
    occurred_at: '2026-11-23T14:34:00.000003-05:00',
    observed_at: '2026-11-24T01:00:00Z',
    ready_notice: 'example-identity',
  }
  const firstVisit = {
    ...observation, observation_id: 'first-visit', mate_id: returningMate, occurred_at: '2026-11-23T10:30Z',
  }
  const betweenVisits = {
    ...firstVisit, observation_id: 'between-visits', occurred_at: '2026-11-23T11:30Z',
  }
  const gapMate = 'controlled-gap-worker'
  const missingLinkRoute = { ...fixture.old, machine: 'Hilda' }
  const afterGap = await record({
    mate_id: gapMate, effective_start_at: '2026-11-23T12:00Z', old: missingLinkRoute,
  })
  const beforeGap = await record({ mate_id: gapMate, effective_start_at: '2026-11-23T10:00Z' })
  const gapRow = { ...betweenVisits, observation_id: 'gap-b', mate_id: gapMate }
  const gapRows = [
    gapRow,
    { ...gapRow, observation_id: 'gap-c', route: missingLinkRoute },
    { ...gapRow, observation_id: 'gap-start', route: undefined, occurred_at: '2026-11-23T10:00Z' },
  ]
  const rows = [
    observation,
    betweenVisits,
    ...gapRows,
    { ...gapRow, observation_id: 'gap-end', occurred_at: '2026-11-23T12:00Z' },
    firstVisit,
    { ...firstVisit, observation_id: 'at-return', occurred_at: '2026-11-23T12:00Z' },
    { ...observation, observation_id: 'at-cutover', occurred_at: '2026-11-23T14:34:00.0000040-05:00' },
    { ...observation, observation_id: 'after-cutover', occurred_at: '2026-11-23T19:35Z' },
    { ...observation, observation_id: 'old-route', route: fixture.old },
    { ...observation, observation_id: 'other-mate', mate_id: 'another-mate' },
    { ...observation, observation_id: 'other-machine', route: { ...fixture.new, machine: 'Hilda' } },
    { ...observation, observation_id: 'other-provider', route: { ...fixture.new, provider: 'another-provider' } },
    { ...observation, observation_id: 'legacy-row', route: { runtime: 'Codex' } },
    { ...observation, observation_id: 'unknown-time', occurred_at: null },
  ]
  const input = join(directory, 'observations.jsonl')
  const original = '{\n' + rows.map(row => JSON.stringify(row)).join('\n') + '\n{\n'
  await writeFile(input, original, { mode: 0o400 })
  const { stdout, stderr } = await exec('sh', [
    '-c', 'exec "$1" --disable-warning=ExperimentalWarning "$2" --db "$3" routing-metrics-input < "$4"',
    'routing-test', process.execPath, cli, db, input,
  ])
  deepEqual(stdout.trim().split('\n').map(JSON.parse), rows.slice(2 + gapRows.length))
  deepEqual(stderr.trim().split('\n').map(JSON.parse), [
    { warning: 'routing.invalid_json', line: 1, skipped_rows: 1 },
    {
      warning: 'routing.historical_timestamp_excluded',
      observation_id: observation.observation_id,
      mate_id: fixture.mate_id,
      route: fixture.new,
      occurred_at: observation.occurred_at,
      effective_start_at: preciseCutover,
      migration_event_id: receipt.event_id,
    },
    {
      warning: 'routing.historical_timestamp_excluded',
      observation_id: betweenVisits.observation_id,
      mate_id: returningMate,
      route: fixture.new,
      occurred_at: betweenVisits.occurred_at,
      effective_start_at: returnReceipt.effective_start_at,
      migration_event_id: returnReceipt.event_id,
    },
    ...gapRows.map(row => ({
      warning: 'routing.uncovered_timestamp_excluded',
      observation_id: row.observation_id,
      mate_id: gapMate,
      occurred_at: row.occurred_at,
      previous_migration_event_id: beforeGap.event_id,
      next_migration_event_id: afterGap.event_id,
    })),
    { warning: 'routing.invalid_json', line: rows.length + 2, skipped_rows: 2 },
  ])
  equal(await readFile(input, 'utf8'), original)
  equal((await run('replay', '--source', 'routing', '--after', '0', '--json')).stdout.trim().split('\n').length, 6)
})

import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { decode } from '@toon-format/toon'

const run = promisify(execFile)
const taskFields = 'blocked,held,hold_reason,hold_kind,hold_until,created,closed,deps,priority'
const taskStates = new Set(['queued', 'in_flight', 'done'])
const workerStates = new Set(['working', 'idle', 'parked', 'done', 'blocked', 'paused', 'failed'])
const workerSources = new Set(['run-step', 'pane'])
const reportedWorkerSources = new Set([...workerSources, 'status-log', 'none', 'remote-endpoint'])
const historicalStates = new Set(['working', 'parked', 'done', 'blocked', 'paused', 'failed', 'needs-decision', 'resolved'])
const holdKinds = new Set(['captain', 'external', 'load', 'parked', 'future'])
const dependencyTypes = new Set(['blocked-by', 'parent', 'discovered-from'])
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const dateStamp = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0

export function entityId(type, ...parts) {
  return ['firstmate', type, ...parts.map(encodeURIComponent)].join(':')
}

export function sourcesFor(home) {
  return [
    { type: 'task', coverage: 'active-backlog', command: 'bin/fm-tasks-axi.sh list' },
    { type: 'worker', coverage: 'local-worker-incarnations', command: 'bin/fm-fleet-snapshot.sh --json' },
  ].map(source => ({
    ...source,
    home_id: home.id,
    home_path: home.path,
    source_id: entityId('home', home.id, source.type),
    mode: home.mode,
  }))
}

class ObservationError extends Error {
  constructor(health, reason) {
    super(reason)
    this.health = health
  }
}

function partial(reason) {
  throw new ObservationError('partial', reason)
}

function normalizedDependencies(value, home) {
  if (value === 'none') return []
  if (typeof value !== 'string') partial('invalid task dependency field')
  return [...new Set(value.split(','))].sort(compare).map(edge => {
    const [type, id, extra] = edge.split(':')
    if (extra !== undefined || !dependencyTypes.has(type) || !identifier.test(id ?? '')) {
      partial('invalid task dependency edge')
    }
    return { type, id: entityId('task', home, id) }
  })
}

export function fleetPullRequests(text, homePath, startedAt, observedAt) {
  const links = new Map()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return links
  }
  const generated = Date.parse(data?.generated)
  if (data?.schema !== 'fm-fleet-snapshot.v1' || data.fm_home !== homePath ||
      data.complete === false || data.truncated === true || data.main_inventory?.valid !== true ||
      !Number.isFinite(generated) || generated < Date.parse(startedAt) - 1000 ||
      generated > Date.parse(observedAt) || data.backlog?.present !== true ||
      !Array.isArray(data.backlog.records)) return links

  const ids = new Set()
  for (const row of data.backlog.records) {
    if (typeof row?.id !== 'string' || !identifier.test(row.id) || ids.has(row.id)) return new Map()
    ids.add(row.id)
    if (!Array.isArray(row.links) && (row.links !== undefined || typeof row.pr_url !== 'string')) continue
    const urls = [...(row.links ?? []).map(link => typeof link === 'string' ? link : link?.url), row.pr_url]
    const exact = urls.filter(url => typeof url === 'string' && url === url.trim() &&
      /^https:\/\/github\.com\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/pull\/[1-9]\d*\/?$/u.test(url))
    links.set(row.id, [...new Set(exact.map(url => url.replace(/\/$/, '')))].sort(compare))
  }
  return links
}

export function withPullRequests(entries, links) {
  return entries.map(entry => {
    const urls = links.get(entry.evidence.task_id)
    return urls === undefined
      ? { ...entry, evidence: { ...entry.evidence, pr_link_coverage: 'unobserved' } }
      : { ...entry, fields: { ...entry.fields, pull_requests: urls },
          evidence: { ...entry.evidence, pr_link_source: 'fleet-snapshot backlog' } }
  })
}

function sourceDate(value) {
  if (value === '-') return null
  if (typeof value !== 'string' || !dateStamp.test(value) || !Number.isFinite(Date.parse(value))) {
    partial('invalid task date field')
  }
  return value
}

export function parseTasks(text, homeId) {
  let data
  try {
    data = decode(text)
  } catch {
    partial('invalid tasks-axi list output')
  }
  if (!data || !Number.isSafeInteger(data.count) || data.count < 0 ||
      !(Array.isArray(data.tasks) && data.tasks.length === data.count ||
        data.count === 0 && data.tasks === '0 tasks in this backlog')) {
    partial('tasks-axi list is incomplete or has no matching count')
  }

  const ids = new Set()
  return (data.count === 0 ? [] : data.tasks).map(row => {
    if (!row || typeof row.id !== 'string' || !identifier.test(row.id) || ids.has(row.id) ||
        !taskStates.has(row.state) || !['yes', 'no'].includes(row.blocked) ||
        !['yes', 'no'].includes(row.held) || typeof row.hold_reason !== 'string' ||
        typeof row.hold_kind !== 'string' ||
        !(row.priority === '-' || Number.isInteger(row.priority) && row.priority >= 0 && row.priority <= 4)) {
      partial('invalid or duplicate tasks-axi row')
    }
    ids.add(row.id)
    const dependencies = normalizedDependencies(row.deps, homeId)
    const held = row.held === 'yes'
    const blocked = row.blocked === 'yes'
    return {
      id: entityId('task', homeId, row.id),
      fields: {
        created: sourceDate(row.created),
        state: row.state,
        closed: sourceDate(row.closed),
        hold_configured: held || row.hold_reason !== '-' || row.hold_kind !== '-' || row.hold_until !== '-',
        hold_kind: holdKinds.has(row.hold_kind) ? row.hold_kind : null,
        hold_until: sourceDate(row.hold_until),
        dependencies,
        priority: row.priority === '-' ? null : row.priority,
        blocked,
        held,
        ready: row.state === 'queued' && row.kind !== 'public-followup' && !blocked && !held,
      },
      related: dependencies.map(dep => ({ relation: dep.type, subject: { type: 'task', id: dep.id } })),
      evidence: { task_id: row.id, state_source: 'tasks-axi list' },
    }
  })
}

export function parseWorkers(text, home, startedAt, observedAt) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    partial('invalid fleet JSON')
  }
  if (data?.schema !== 'fm-fleet-snapshot.v1' || data.fm_home !== home.path ||
      !Array.isArray(data.tasks) || data.complete === false || data.truncated === true ||
      data.main_inventory?.valid !== true ||
      data.secondmate_current?.registry?.present !== false) {
    partial('fleet snapshot lacks verified local inventory')
  }
  const generated = Date.parse(data.generated)
  if (!Number.isFinite(generated) || generated < Date.parse(startedAt) - 1000 ||
      generated > Date.parse(observedAt)) {
    throw new ObservationError('stale', 'fleet generation time is outside this collection window')
  }

  const entries = []
  const counts = { remote_excluded: 0, current_state_unavailable: 0 }
  const ids = new Set()
  const mates = new Set(Array.isArray(data.secondmate_current.records)
    ? data.secondmate_current.records.map(record => record?.id) : [])
  for (const row of data.tasks) {
    if (typeof row?.id !== 'string' || !identifier.test(row.id) || ids.has(row.id) ||
        !Object.hasOwn(row, 'remote')) {
      partial('invalid or duplicate fleet worker row')
    }
    ids.add(row.id)
    if (row.remote !== null) {
      if (typeof row.remote?.host !== 'string' || !row.remote.host.trim() ||
          typeof row.remote.root !== 'string' || !isAbsolute(row.remote.root)) {
        partial('invalid remote fleet worker descriptor')
      }
      counts.remote_excluded++
      continue
    }
    if (row.kind === 'secondmate' || row.role === 'secondmate' || mates.has(row.id)) continue
    if (typeof row.spawn_gen !== 'string' || !identifier.test(row.spawn_gen)) {
      partial('local fleet worker lacks a valid spawn generation')
    }
    const current = row.current_state
    const fresh = current?.freshness === 'fresh' && Date.parse(current.observed_at) === generated
    const valid = fresh &&
      workerStates.has(current.state) && workerSources.has(current.source)
    if (!valid) counts.current_state_unavailable++
    const historicalState = row.paths?.status_log?.last_event?.state
    entries.push({
      id: entityId('worker', home.id, row.id, row.spawn_gen),
      fields: valid ? { current_state: current.state } : null,
      sample: {
        current_state: valid ? current.state : 'unknown',
        reason: valid ? null : fresh ? 'current state could not be verified' : 'missing or stale current-state read',
      },
      related: [], // A same-named worker alone does not prove a tasks-axi row exists.
      evidence: {
        task_id: row.id,
        spawn_gen: row.spawn_gen,
        state_source: reportedWorkerSources.has(current?.source) ? current.source : null,
        historical_last_event: historicalStates.has(historicalState) ? historicalState : null,
      },
    })
  }
  return { entries, counts, generated_at: new Date(generated).toISOString() }
}

async function backlogFingerprint(dataPath) {
  const path = join(dataPath, 'backlog.md')
  try {
    const info = await lstat(path, { bigint: true })
    if (!info.isFile()) return null
    await access(path, constants.R_OK)
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':')
  } catch {
    return null
  }
}

async function fingerprintConfig(home) {
  try {
    const info = await lstat(join(home.path, '.tasks.toml'), { bigint: true })
    return info.isFile() ? [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':') : null
  } catch (error) {
    return error.code === 'ENOENT' ? 'default markdown configuration' : null
  }
}

// tasks-axi evaluates date holds in local calendar time.
function localDay(date) {
  return [date.getFullYear(), date.getMonth(), date.getDate()].join('-')
}

async function readTasks(home, cache, now) {
  const dataPath = join(home.path, 'data')
  const day = localDay(now())
  const before = await backlogFingerprint(dataPath)
  const config = home.markdownFastPath ? await fingerprintConfig(home) : null
  const checkedAt = now()
  if (cache && config && config === cache.config && before && before === cache.fingerprint &&
      day === cache.day && day === localDay(checkedAt) && Date.parse(cache.refreshed_at) + 60_000 > checkedAt.getTime()) {
    return { entries: cache.entries, method: 'markdown-fingerprint' }
  }

  const readDay = localDay(checkedAt)
  if (cache) cache.fingerprint = null
  const text = await runRead(home, 'fm-tasks-axi.sh', ['list', '--fields', taskFields], {})
  const entries = parseTasks(text, home.id)
  const after = await backlogFingerprint(dataPath)
  // Some tasks-axi builds return a successful empty list for a missing file.
  if (!entries.length && (!before || before !== after)) {
    partial('empty task list without a stable, readable local backlog')
  }
  const cacheable = cache && config && (cache.config === undefined || cache.config === config) &&
    before && before === after && config === await fingerprintConfig(home)
  const finishedAt = now()
  if (readDay !== localDay(finishedAt)) partial('local date changed during the task read')
  if (cacheable) {
    Object.assign(cache, { config, fingerprint: after, day: readDay, entries, refreshed_at: finishedAt.toISOString() })
  }
  return { entries, method: 'tasks-axi-list' }
}

async function runRead(home, script, args, overrides) {
  // Ambient First Mate overrides can point a command at another home's state.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FM_')))
  const command = join(home.codeRoot ?? home.path, 'bin', script)
  try {
    const { stdout } = await run('timeout', ['--kill-after=2s', '18s', command, ...args], {
      env: { ...env, FM_HOME: home.path, ...overrides },
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf8',
    })
    return stdout
  } catch (error) {
    // execFile failures include stdout/stderr. Keep only a bounded diagnostic.
    const reason = error.code === 124 || error.code === 137 ? 'read timed out'
      : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'read exceeded 16 MiB'
      : error.code === 126 || error.code === 127 || error.code === 'ENOENT' ? 'read command is missing or inaccessible'
      : 'read command failed'
    throw new ObservationError('unavailable', reason)
  }
}

export async function observeHome(home, scratch, { now = () => new Date(), taskCache } = {}) {
  const [task, worker] = sourcesFor(home)
  const started_at = now().toISOString()
  const attempt = async (source, started_at, read) => {
    try {
      return { source, started_at, ...await read() }
    } catch (error) {
      if (!(error instanceof ObservationError)) throw error
      return { source, started_at, observed_at: now().toISOString(), health: error.health, reason: error.message }
    }
  }

  if (!home.path || await realpath(home.path).catch(() => null) !== home.path) {
    return [task, worker].map(source => ({
      source, started_at, observed_at: now().toISOString(),
      health: 'unavailable', reason: 'configured FM_HOME could not be verified',
    }))
  }

  const tasks = await attempt(task, started_at, async () => {
    const payload = await readTasks(home, taskCache, now)
    return { ...payload, observed_at: now().toISOString(), health: 'ok' }
  })
  const fleetStartedAt = now().toISOString()
  let text
  let fleetObservedAt
  const workers = await attempt(worker, fleetStartedAt, async () => {
    text = await runRead(home, 'fm-fleet-snapshot.sh', ['--json'], {
      FM_DATA_OVERRIDE: scratch,
      FM_SNAPSHOT_CACHE_DIR: join(scratch, 'disabled', 'cache'),
      FM_CREW_STATE_NO_FORGE: '1',
    })
    fleetObservedAt = now().toISOString()
    const payload = parseWorkers(text, home, fleetStartedAt, fleetObservedAt)
    const incomplete = payload.counts.current_state_unavailable > 0
    return {
      ...payload, observed_at: fleetObservedAt,
      health: incomplete ? 'partial' : 'ok',
      reason: incomplete ? 'some local incarnations have no verified current state' : null,
    }
  })
  if (tasks.entries?.length) {
    const links = fleetPullRequests(text, home.path, fleetStartedAt, fleetObservedAt)
    tasks.entries = withPullRequests(tasks.entries, links)
    const pr_links_unobserved = tasks.entries.filter(entry => entry.evidence.pr_link_coverage === 'unobserved').length
    if (pr_links_unobserved) {
      tasks.counts = { pr_links_unobserved }
      tasks.health = 'partial'
      tasks.reason = 'PR link coverage is unavailable for some tasks'
    }
    if (pr_links_unobserved < tasks.entries.length) tasks.observed_at = fleetObservedAt
  }
  return [tasks, workers]
}

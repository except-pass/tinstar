import { randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { entityId, fleetCommand, prLinkSource, withPullRequests } from './firstmate.js'

const schema = `
CREATE TABLE IF NOT EXISTS homes (
  home_id TEXT PRIMARY KEY,
  path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  last_attempt_started TEXT,
  last_attempt_at TEXT,
  last_snapshot_id TEXT,
  last_success_at TEXT,
  last_generated_at TEXT,
  health TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  counts TEXT
);
CREATE TABLE IF NOT EXISTS entities (
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  entity_id TEXT NOT NULL,
  last_seen_snapshot TEXT NOT NULL,
  snapshot_id TEXT,
  started_at TEXT,
  observed_at TEXT,
  fields TEXT,
  evidence TEXT,
  PRIMARY KEY (source_id, entity_id)
);
CREATE TABLE IF NOT EXISTS worker_samples (
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  entity_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  current_state TEXT NOT NULL,
  reason TEXT,
  evidence TEXT NOT NULL,
  PRIMARY KEY (source_id, entity_id)
);
CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  envelope TEXT NOT NULL
);
`

function writerPath(path) {
  path = resolve(path)
  const directory = dirname(path)
  const components = []
  for (let current = directory; ; current = dirname(current)) {
    components.push(current)
    if (current === dirname(current)) break
  }
  const owner = process.geteuid()
  for (const current of components.reverse()) {
    let info = lstatSync(current, { throwIfNoEntry: false })
    if (!info) {
      try {
        mkdirSync(current, { mode: 0o700 })
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
      info = lstatSync(current)
    }
    const direct = current === directory
    const trustedOwner = info.uid === owner || (!direct && info.uid === 0)
    const writable = (info.mode & 0o022) !== 0
    const stickyAncestor = !direct && (info.mode & 0o1000) !== 0
    if (!info.isDirectory() || !trustedOwner || (writable && !stickyAncestor)) {
      throw new JournalConfigurationError('use a service-owned journal directory protected from file replacement and sidecar creation by other users')
    }
  }
  return path
}

function openJournal(path, readOnly) {
  if (!readOnly) {
    path = writerPath(path)
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const file = lstatSync(path + suffix, { throwIfNoEntry: false })
      if (file && (!file.isFile() || file.uid !== process.geteuid() || (file.mode & 0o077) !== 0)) {
        throw new JournalConfigurationError('journal and SQLite sidecars must be regular files with owner-only access')
      }
    }
    closeSync(openSync(path, 'a', 0o600))
  }
  const db = new DatabaseSync(path, { readOnly })
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    if (!readOnly) {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL')
      db.exec(schema)
    }
  } catch (error) {
    db.close()
    throw error
  }
  return db
}

function eventChanges(type, before, fields) {
  if (!before) return [{ event_type: `${type}.observed`, change: { after: fields } }]
  return Object.keys(fields)
    .filter(field => JSON.stringify(before[field]) !== JSON.stringify(fields[field]))
    .map(field => ({
      event_type: `${type}.${field}.changed`,
      change: { field, before: before[field], after: fields[field] },
    }))
}

function readEvent(row) {
  return row ? { ...JSON.parse(row.envelope), sequence: row.sequence } : null
}

export class JournalConfigurationError extends Error {}

export class Journal {
  constructor(path, { readOnly = false } = {}) {
    this.db = openJournal(path, readOnly)
  }

  close() {
    this.db.close()
  }

  registerSources(sources) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const source of sources) this.register(source)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  register({ home_path, ...source }) {
    const binding = home_path === null ? null : this.db.prepare(`
      INSERT INTO homes (home_id, path)
      SELECT ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM homes WHERE path = ? AND home_id <> ?)
      ON CONFLICT(home_id) DO UPDATE SET path = excluded.path
      WHERE homes.path = excluded.path
    `).run(source.home_id, home_path, home_path, source.home_id)
    if (binding && !binding.changes) {
      throw new JournalConfigurationError('home ID or FM_HOME path is already bound to a different pairing')
    }
    const result = this.db.prepare(`
      INSERT INTO sources (source_id, description) VALUES (?, ?)
      ON CONFLICT(source_id) DO UPDATE SET description = excluded.description
      WHERE json_extract(sources.description, '$.mode') = json_extract(excluded.description, '$.mode')
    `).run(source.source_id, JSON.stringify(source))
    // Otherwise fixture state could generate a fabricated live transition.
    if (!result.changes) throw new JournalConfigurationError('use a separate journal for live and fixture baselines')
  }

  record(observation) {
    const { source, started_at, entries, generated_at } = observation
    let { observed_at } = observation
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare('SELECT * FROM sources WHERE source_id = ?').get(source.source_id)
      // Registration is separate so the tail can show pending sources even if
      // they have never completed a read.
      if (!previous) throw new Error('observation source was not registered')
      let written = 0
      if (!previous.last_attempt_started || started_at > previous.last_attempt_started) {
        let { health, reason = null, counts = null } = observation
        let snapshotId = null
        let acceptedGeneration = null
        if (entries && previous.last_attempt_at && started_at < previous.last_attempt_at) {
          health = 'stale'
          reason = 'read overlaps the previous collection window'
        } else if (generated_at && previous.last_generated_at && generated_at <= previous.last_generated_at) {
          health = 'stale'
          reason = 'fleet watermark did not advance'
        } else if (entries && (source.type !== 'task' || health === 'ok')) {
          snapshotId = randomUUID()
          acceptedGeneration = generated_at ?? null
          if (source.type === 'task') {
            const pr = observation.pullRequests
            const worker = this.db.prepare('SELECT last_generated_at FROM sources WHERE source_id = ?')
              .get(entityId('home', source.home_id, 'worker'))
            const fresh = pr && pr.generated_at > (previous.last_generated_at ?? '') &&
              pr.generated_at > (worker?.last_generated_at ?? '')
            const projected = withPullRequests(entries, fresh ? pr.links : null)
            const pr_links_unobserved = projected.filter(entry => entry.evidence.pr_link_coverage === 'unobserved').length
            counts = pr_links_unobserved ? { pr_links_unobserved } : null
            const contributesPullRequests = fresh && pr_links_unobserved < entries.length
            acceptedGeneration = contributesPullRequests ? pr.generated_at : null
            if (contributesPullRequests) observed_at = pr.observed_at
            observation = { ...observation, observed_at, entries: projected }
          }
          written = this.recordEntries(observation, previous, snapshotId)
        }
        this.db.prepare(`
          UPDATE sources SET last_attempt_started = ?, last_attempt_at = ?, health = ?, reason = ?,
            counts = ?, last_snapshot_id = COALESCE(?, last_snapshot_id),
            last_success_at = COALESCE(?, last_success_at),
            last_generated_at = COALESCE(?, last_generated_at)
          WHERE source_id = ?
        `).run(started_at, observed_at, health, reason, JSON.stringify(counts),
          snapshotId, snapshotId ? observed_at : null,
          acceptedGeneration, source.source_id)
      }
      this.db.exec('COMMIT')
      return written
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  recordEntries(observation, previous, snapshotId) {
    const previousSnapshot = previous.last_snapshot_id
    const { source, started_at, observed_at } = observation
    const select = this.db.prepare('SELECT * FROM entities WHERE source_id = ? AND entity_id = ?')
    const save = this.db.prepare(`
      INSERT INTO entities (source_id, entity_id, last_seen_snapshot, snapshot_id, started_at, observed_at, fields, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, entity_id) DO UPDATE SET last_seen_snapshot = excluded.last_seen_snapshot,
        snapshot_id = COALESCE(excluded.snapshot_id, snapshot_id),
        started_at = COALESCE(excluded.started_at, started_at),
        observed_at = COALESCE(excluded.observed_at, observed_at),
        fields = COALESCE(excluded.fields, fields), evidence = COALESCE(excluded.evidence, evidence)
    `)
    const append = this.db.prepare(`
      INSERT INTO events (event_id, source_id, subject_type, subject_id, envelope) VALUES (?, ?, ?, ?, ?)
    `)
    const saveWorker = source.type === 'worker' ? this.db.prepare(`
      INSERT INTO worker_samples (source_id, entity_id, snapshot_id, observed_at, current_state, reason, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, entity_id) DO UPDATE SET snapshot_id = excluded.snapshot_id,
        observed_at = excluded.observed_at, current_state = excluded.current_state,
        reason = excluded.reason, evidence = excluded.evidence
    `) : null
    let count = 0
    const entries = [...observation.entries].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    for (const entry of entries) {
      const prior = select.get(source.source_id, entry.id)
      const before = prior?.fields ? JSON.parse(prior.fields) : null
      const fields = entry.fields ? JSON.stringify({ ...before, ...entry.fields }) : null
      const previousEvidence = prior?.evidence ? JSON.parse(prior.evidence) : null
      const rebaselinePullRequests = source.type === 'task' && before && Object.hasOwn(entry.fields, 'pull_requests') &&
        (previous.health !== 'ok' || previous.last_attempt_at !== previous.last_success_at ||
          prior.last_seen_snapshot !== previousSnapshot || !Object.hasOwn(before, 'pull_requests') ||
          previousEvidence?.pr_link_source !== prLinkSource)
      const evidence = {
        ...entry.evidence,
        ...(rebaselinePullRequests ? { pr_link_coverage: 'rebaselined' } : {}),
      }
      // Unavailable worker states count toward inventory coverage. Only a
      // verified per-incarnation observation may advance its state snapshot.
      saveWorker?.run(source.source_id, entry.id, snapshotId, observed_at,
        entry.sample.current_state, entry.sample.reason, JSON.stringify(evidence))
      if (previousSnapshot && fields && fields !== prior?.fields) {
        const related = this.relationships(source, entry)
        for (const difference of eventChanges(source.type, before, entry.fields)) {
          const pullRequestChange = difference.change.field === 'pull_requests'
          if (pullRequestChange && rebaselinePullRequests) continue
          const includesPullRequests = pullRequestChange || Object.hasOwn(difference.change.after ?? {}, 'pull_requests')
          const envelope = {
            schema: 'event-publisher.event.v1',
            event_id: `event:${randomUUID()}`,
            ...difference,
            source: { provider: 'firstmate', source_id: source.source_id, home_id: source.home_id, mode: source.mode },
            subject: { type: source.type, id: entry.id },
            observed_at,
            occurred_at: null,
            observation: {
              method: 'snapshot-diff',
              read_method: pullRequestChange ? 'fleet-snapshot' : observation.method ?? 'fleet-snapshot',
              coverage: source.coverage,
              batch_id: snapshotId,
              previous_snapshot: prior?.snapshot_id ?? prior?.last_seen_snapshot ?? previousSnapshot,
              current_snapshot: snapshotId,
              observed_between: { after: prior?.started_at ?? null, by: observed_at },
            },
            related,
            evidence: {
              source_reference: { interface: pullRequestChange ? fleetCommand : source.command, task_id: entry.evidence.task_id,
                ...(includesPullRequests && !pullRequestChange ? { pr_link_interface: fleetCommand } : {}),
                ...(entry.evidence.spawn_gen ? { spawn_gen: entry.evidence.spawn_gen } : {}) },
              state_source: pullRequestChange ? prLinkSource : entry.evidence.state_source,
              ...(previousEvidence ? { previous_state_source: pullRequestChange ? prLinkSource : previousEvidence.state_source } : {}),
              ...(evidence.pr_link_coverage ? { pr_link_coverage: evidence.pr_link_coverage } : {}),
              ...(evidence.pr_link_source ? { pr_link_source: evidence.pr_link_source } : {}),
              ...(source.type === 'worker' ? { historical_last_event: entry.evidence.historical_last_event } : {}),
              confidence_basis: before ? 'field differs across verified observations'
                : prior ? 'first verified state for a previously seen incarnation'
                : 'first seen after the initial inventory',
            },
          }
          append.run(envelope.event_id, source.source_id, source.type, entry.id, JSON.stringify(envelope))
          count++
        }
      }
      save.run(source.source_id, entry.id, snapshotId, fields ? snapshotId : null,
        fields ? started_at : null, fields ? observed_at : null, fields,
        fields ? JSON.stringify(evidence) : null)
    }
    // Missing entities are retained. Only an observed field value can change
    // their last known state and inventory absence never asserts deletion.
    return count
  }

  relationships(source, entry) {
    if (source.type !== 'worker') return entry.related
    const taskSource = entityId('home', source.home_id, 'task')
    const taskId = entityId('task', source.home_id, entry.evidence.task_id)
    const task = this.db.prepare(`
      SELECT 1 FROM entities e JOIN sources s USING (source_id)
      WHERE e.source_id = ? AND e.entity_id = ? AND e.last_seen_snapshot = s.last_snapshot_id
        AND s.health = 'ok' AND json_extract(s.description, '$.mode') = ?
    `).get(taskSource, taskId, source.mode)
    return task ? [{ relation: 'executes', subject: { type: 'task', id: taskId } }] : []
  }

  sources() {
    return this.db.prepare('SELECT * FROM sources ORDER BY source_id').all().map(row => {
      const { description, counts, source_id, ...health } = row
      return { ...JSON.parse(description), ...health, counts: counts ? JSON.parse(counts) : null }
    })
  }

  tail() {
    return this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS n FROM events').get().n
  }

  inspect(id) {
    return readEvent(this.db.prepare('SELECT sequence, envelope FROM events WHERE event_id = ?').get(id))
  }

  cursorBeforeLast(through, count, { type, entity }) {
    const row = this.db.prepare(`
      SELECT sequence FROM events
      WHERE sequence <= ?
        AND (? IS NULL OR subject_type = ?)
        AND (? IS NULL OR subject_id = ?)
      ORDER BY sequence DESC LIMIT 1 OFFSET ?
    `).get(through, type ?? null, type ?? null, entity ?? null, entity ?? null, count - 1)
    return row ? row.sequence - 1 : 0
  }

  events({ after = 0, through = Number.MAX_SAFE_INTEGER, limit = 100, type, entity } = {}) {
    const rows = this.db.prepare(`
      SELECT sequence, envelope FROM events
      WHERE sequence > ? AND sequence <= ?
        AND (? IS NULL OR subject_type = ?)
        AND (? IS NULL OR subject_id = ?)
      ORDER BY sequence LIMIT ?
    `).all(after, through, type ?? null, type ?? null, entity ?? null, entity ?? null, limit)
    return rows.map(readEvent)
  }
}

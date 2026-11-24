import { randomUUID } from 'node:crypto'
import { closeSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { entityId, fleetCommand, prLinkSource, withPullRequests } from './firstmate.js'
import { pendingTagEvidence, tagRepository, tagSource } from './releaseTags.js'
import { migrationSource, migrationSourceId } from './routing.js'

const insertEvent = 'INSERT INTO events (event_id, source_id, subject_type, subject_id, envelope) VALUES (?, ?, ?, ?, ?)'

const schema = `
CREATE TABLE IF NOT EXISTS homes (
  home_id TEXT PRIMARY KEY,
  path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS fleet_windows (
  home_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  generated_at TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS worker_samples_inventory ON worker_samples (source_id, snapshot_id, entity_id);
CREATE TABLE IF NOT EXISTS jira_deliveries (
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  delivery_id TEXT NOT NULL,
  native_id TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (source_id, delivery_id),
  UNIQUE (source_id, native_id)
);
CREATE TABLE IF NOT EXISTS events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL REFERENCES sources(source_id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  envelope TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS release_tag_evidence (
  event_id TEXT PRIMARY KEY REFERENCES events(event_id),
  next_attempt_at TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jetstream_relays (
  name TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  health TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  last_ack_at TEXT,
  updated_at TEXT
);
`

function freshFleet(read, window, previousGeneration, allowSameRead = false) {
  if (read.generated_at <= (previousGeneration ?? '')) return false
  if (!window) return true
  return (read.started_at >= window.observed_at && read.generated_at > window.generated_at) ||
    (allowSameRead && read.started_at === window.started_at && read.observed_at === window.observed_at &&
      read.generated_at === window.generated_at)
}

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
  if (!before) {
    const { pull_requests, ...after } = fields
    const events = [{ event_type: `${type}.observed`, change: { after } }]
    if (pull_requests?.length) {
      events.push({
        event_type: 'task.pull_requests.observed',
        change: { field: 'pull_requests', after: pull_requests },
      })
    }
    return events
  }
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

function releaseTagEvent(subject, tag, sha, observed_at, event_type, label, change, extra = {}) {
  return {
    schema: 'event-publisher.event.v1', event_type, label,
    source: { provider: tagSource.provider, source_id: tagSource.source_id, mode: tagSource.mode },
    subject: { type: tagSource.type, id: subject }, observed_at, occurred_at: null,
    observation: {
      method: 'snapshot-diff',
      read_method: event_type === 'tag.evidence.updated' ? 'loopback GET /api/releases' : tagSource.command,
      coverage: tagSource.coverage,
    },
    related: [], change,
    evidence: { source_reference: { repository: tagRepository, tag, sha }, ...extra },
  }
}

export class JournalConfigurationError extends Error {}
export class RelayCheckpointError extends Error {}

export class Journal {
  constructor(path, { readOnly = false } = {}) {
    this.db = openJournal(path, readOnly)
  }

  close() {
    this.db.close()
  }

  registerSources(sources, { reconcile = false } = {}) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const source of sources) this.register(source)
      if (reconcile) {
        // Local CLI receipts have no collector entry in the configuration.
        this.db.prepare(`
          UPDATE sources SET description = json_set(description, '$.configured', 0)
          WHERE source_id <> ? AND source_id NOT IN (SELECT value FROM json_each(?))
        `).run(migrationSourceId, JSON.stringify(sources.map(source => source.source_id)))
      }
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
      WHERE json_extract(sources.description, '$.mode') IS json_extract(excluded.description, '$.mode')
    `).run(source.source_id, JSON.stringify(source))
    // Otherwise fixture state could generate a fabricated live transition.
    if (!result.changes) throw new JournalConfigurationError('use a separate journal for live and fixture baselines')
  }

  record(observation) {
    return this.recordAttempt(observation).written
  }

  recordMigration(event) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (event.source.mode === 'fixture' && this.db.prepare(`
        SELECT 1 FROM sources
        WHERE json_extract(description, '$.mode') = 'live'
           OR json_extract(description, '$.provider') = 'jira'
        LIMIT 1
      `).get()) {
        throw new JournalConfigurationError('use a separate journal for live and fixture baselines')
      }
      this.register(migrationSource(event.source.mode))
      let receipt = this.inspect(event.event_id)
      if (!receipt) {
        const { lastInsertRowid: sequence } = this.db.prepare(insertEvent)
          .run(event.event_id, migrationSourceId, event.subject.type, event.subject.id, JSON.stringify(event))
        this.db.prepare(`
          UPDATE sources SET last_attempt_at = ?, last_success_at = ?, health = 'ok'
          WHERE source_id = ?
        `).run(event.observed_at, event.observed_at, migrationSourceId)
        receipt = { ...event, sequence }
      }
      this.db.exec('COMMIT')
      return receipt
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  *migrationReceipts() {
    const rows = this.db.prepare(`
      SELECT sequence, envelope FROM events JOIN sources USING (source_id)
      WHERE source_id = ?
        AND json_extract(envelope, '$.source.mode') = json_extract(description, '$.mode')
      ORDER BY sequence
    `)
    for (const row of rows.iterate(migrationSourceId)) yield readEvent(row)
  }

  hasJiraDelivery(sourceId, deliveryId, native) {
    return this.db.prepare(`
      SELECT 1 FROM jira_deliveries
      WHERE source_id = ? AND (delivery_id = ? OR native_id = ?)
      LIMIT 1
    `).get(sourceId, deliveryId, native) !== undefined
  }

  recordJiraDelivery(sourceId, deliveryId, { native, observedAt, events, reason }) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const registered = this.db.prepare(`
        SELECT 1 FROM sources WHERE source_id = ?
          AND json_extract(description, '$.provider') = 'jira'
          AND COALESCE(json_extract(description, '$.configured'), 1) = 1
      `).get(sourceId)
      if (!registered) throw new Error('Jira webhook source is not configured')
      // Claim the delivery and append the whole event group atomically so a
      // lost acknowledgement can be retried safely after restart.
      const accepted = this.db.prepare(`
        INSERT INTO jira_deliveries (source_id, delivery_id, native_id, observed_at)
        VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING
      `).run(sourceId, deliveryId, native, observedAt).changes
      if (accepted) {
        const append = this.db.prepare(insertEvent)
        for (const entry of events) {
          const event_id = `event:${randomUUID()}`
          append.run(event_id, sourceId, entry.subject.type, entry.subject.id, JSON.stringify({ ...entry, event_id }))
        }
        this.db.prepare(`
          UPDATE sources SET last_attempt_at = ?, last_success_at = ?, health = ?, reason = ?
          WHERE source_id = ?
        `).run(observedAt, observedAt, reason ? 'partial' : 'ok', reason ?? null, sourceId)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  linkedPulls(url = null) {
    return this.db.prepare(`
      SELECT DISTINCT e.entity_id AS task_id, link.value AS url
      FROM entities e JOIN sources s USING (source_id),
        json_each(e.fields, '$.pull_requests') AS link
      WHERE s.source_id GLOB 'firstmate:home:*'
        AND json_extract(s.description, '$.type') = 'task'
        AND json_extract(s.description, '$.mode') = 'live'
        AND COALESCE(json_extract(s.description, '$.configured'), 1) = 1
        AND s.health = 'ok' AND e.last_seen_snapshot = s.last_snapshot_id
        AND json_extract(e.evidence, '$.pr_link_source') = ?
        AND (? IS NULL OR link.value = ?)
      ORDER BY url, task_id
    `).all(prLinkSource, url, url)
  }

  recordReleaseTags({ startedAt, observedAt, tags, reason }) {
    const { source_id: sourceId, type } = tagSource
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare('SELECT last_attempt_at, last_success_at FROM sources WHERE source_id = ?').get(sourceId)
      if (observedAt < startedAt || startedAt <= (previous.last_attempt_at ?? '')) {
        this.db.exec('COMMIT')
        return false
      }
      const counts = { observed: tags?.size ?? 0, unconfirmed_missing: 0, deleted: 0 }
      if (tags) {
        const baseline = new Map(this.db.prepare('SELECT entity_id, fields FROM entities WHERE source_id = ?').all(sourceId)
          .map(row => [row.entity_id, JSON.parse(row.fields)]))
        const save = this.db.prepare(`
          INSERT INTO entities (source_id, entity_id, last_seen_snapshot, observed_at, fields)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(source_id, entity_id) DO UPDATE SET
            last_seen_snapshot = excluded.last_seen_snapshot, observed_at = excluded.observed_at, fields = excluded.fields
        `)
        const snapshot = randomUUID()
        const write = (id, fields) => save.run(sourceId, id, snapshot, observedAt, JSON.stringify(fields))
        const append = this.db.prepare(insertEvent + ' ON CONFLICT(event_id) DO NOTHING')
        const publish = (id, event, event_id = `event:${randomUUID()}`) =>
          append.run(event_id, sourceId, type, id, JSON.stringify({ ...event, event_id })).changes
        const seed = !previous.last_success_at
        for (const [tag, sha] of tags) {
          const id = `github:tag:${tagRepository}:${tag}`
          const prior = baseline.get(id)
          baseline.delete(id)
          if (prior?.sha === sha && prior.missing < 2) {
            if (prior.missing) write(id, { ...prior, missing: 0 })
            continue
          }
          let push_event_id = null
          if (!seed) {
            const action = !prior ? 'created' : prior.sha === sha ? 'restored' : 'moved'
            const change = { field: 'sha', before: prior?.sha ?? null, after: sha }
            push_event_id = `event:github:tag:${tagRepository}:${tag}:${sha}`
            const entry = releaseTagEvent(id, tag, sha, observedAt, 'tag.pushed', 'tag pushed', change,
              { action, enrichment: pendingTagEvidence })
            if (publish(id, entry, push_event_id)) {
              this.db.prepare('INSERT INTO release_tag_evidence VALUES (?, ?, ?)').run(push_event_id, observedAt, JSON.stringify(pendingTagEvidence))
            } else {
              // Record the ref transition even when its exact identity already
              // has a push event. A replay consumer receives that push only once.
              publish(id, releaseTagEvent(id, tag, sha, observedAt, 'tag.ref.changed', 'tag ref changed', change,
                { action, push_event_id }))
            }
          }
          write(id, { tag, sha, missing: 0, push_event_id })
        }
        for (const [id, prior] of baseline) {
          if (prior.missing === 2) continue
          // Two complete inventories protect against a temporary absence at a
          // GitHub pagination boundary. Failed inventories never count.
          const missing = prior.missing + 1
          write(id, { ...prior, missing })
          if (missing === 1) counts.unconfirmed_missing++
          else {
            counts.deleted++
            publish(id, releaseTagEvent(id, prior.tag, prior.sha, observedAt, 'tag.deleted', 'tag deleted',
              { field: 'sha', before: prior.sha, after: null }, { action: 'deleted' }))
          }
        }
        this.db.prepare('UPDATE sources SET last_success_at = ?, last_snapshot_id = ? WHERE source_id = ?')
          .run(observedAt, snapshot, sourceId)
      }
      this.db.prepare('UPDATE sources SET last_attempt_at = ?, health = ?, reason = ?, counts = ? WHERE source_id = ?')
        .run(observedAt, tags ? 'ok' : 'unavailable', reason, JSON.stringify(counts), sourceId)
      this.db.exec('COMMIT')
      return !!tags
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  nextReleaseTagEvidence(now) {
    return this.db.prepare(`
      SELECT entity_id AS subject, json_extract(fields, '$.tag') AS tag,
        json_extract(fields, '$.sha') AS sha, event_id, next_attempt_at
      FROM entities JOIN release_tag_evidence ON event_id = json_extract(fields, '$.push_event_id')
      WHERE source_id = ? AND json_extract(fields, '$.missing') = 0 AND next_attempt_at <= ?
      ORDER BY next_attempt_at, entity_id LIMIT 1
    `).get(tagSource.source_id, now)
  }

  recordReleaseTagEvidence(target, detail, observedAt, nextAttemptAt) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.db.prepare(`
        SELECT detail FROM release_tag_evidence JOIN entities
          ON event_id = json_extract(fields, '$.push_event_id')
        WHERE source_id = ? AND entity_id = ? AND event_id = ? AND next_attempt_at = ?
          AND json_extract(fields, '$.missing') = 0
      `).get(tagSource.source_id, target.subject, target.event_id, target.next_attempt_at)
      // An overlapping poll can move the tag while Releases is still reading.
      if (current) {
        const previous = JSON.parse(current.detail)
        const merged = Object.fromEntries(Object.entries({
          pulls: item => item.url,
          cards: item => JSON.stringify([item.pull, item.card_id]),
          runs: item => item.id,
        }).map(([name, identity]) => {
          const incoming = detail?.[name] ?? (name === 'runs' && previous.runs.coverage !== 'pending'
            ? { coverage: 'unknown', items: [] } : null)
          if (!incoming) return [name, previous[name]]
          const { availableLinks, ...group } = incoming
          if (group.coverage === 'complete') return [name, group]
          const retained = availableLinks ? previous[name].items.filter(item =>
            availableLinks.get(item.pull)?.some(link => link.card_id === item.card_id)) : previous[name].items
          const items = new Map(retained.map(item => [
            identity(item), name === 'runs' ? { ...item, freshness: 'last_known' } : item,
          ]))
          for (const item of group.items) items.set(identity(item), item)
          return [name, { ...group, items: [...items.values()] }]
        }))
        const updated = JSON.stringify(merged)
        if (updated !== current.detail) {
          const event_id = `event:${randomUUID()}`
          const event = releaseTagEvent(target.subject, target.tag, target.sha, observedAt,
            'tag.evidence.updated', 'tag evidence updated', { field: 'enrichment', after: merged },
            { push_event_id: target.event_id })
          this.db.prepare(insertEvent).run(event_id, tagSource.source_id, tagSource.type, target.subject, JSON.stringify({ ...event, event_id }))
        }
        this.db.prepare('UPDATE release_tag_evidence SET next_attempt_at = ?, detail = ? WHERE event_id = ?')
          .run(nextAttemptAt, updated, target.event_id)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  recordProviderPoll(source, { startedAt, observedAt, entries, health, reason, counts }, diff) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare('SELECT last_attempt_at FROM sources WHERE source_id = ?').get(source.source_id)
      if (!previous) throw new Error('observation source was not registered')
      let accepted = 0
      if (observedAt >= startedAt && (!previous.last_attempt_at || startedAt >= previous.last_attempt_at)) {
        const snapshot = entries.length ? randomUUID() : null
        const append = this.db.prepare(insertEvent)
        const select = this.db.prepare('SELECT fields, snapshot_id, started_at FROM entities WHERE source_id = ? AND entity_id = ?')
        const save = this.db.prepare(`
          INSERT INTO entities (source_id, entity_id, last_seen_snapshot, snapshot_id, started_at, observed_at, fields, evidence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_id, entity_id) DO UPDATE SET last_seen_snapshot = excluded.last_seen_snapshot,
            snapshot_id = excluded.snapshot_id, started_at = excluded.started_at, observed_at = excluded.observed_at,
            fields = excluded.fields, evidence = excluded.evidence
        `)
        for (const entry of entries) {
          const prior = select.get(source.source_id, entry.id)
          const result = diff(prior ? JSON.parse(prior.fields) : null, entry.fields,
            { snapshot, startedAt: entry.startedAt })
          // A provider can recognize an older source revision after restart.
          if (result === null) continue
          const { changes, fields = entry.fields } = result
          const related = source.provider === 'github' ?
            this.linkedPulls(entry.evidence.source_reference.url).map(({ task_id }) => ({
              relation: 'linked-task', subject: { type: 'task', id: task_id },
            })) : entry.related
          accepted++
          for (const { previous = prior, ...difference } of changes) {
            const event_id = `event:${randomUUID()}`
            const event = {
              schema: 'event-publisher.event.v1', event_id, ...difference,
              source: { provider: source.provider, source_id: source.source_id, mode: source.mode },
              subject: { type: source.type, id: entry.id },
              observed_at: entry.observedAt, occurred_at: entry.occurredAt ?? null,
              observation: {
                method: entry.occurredAt ? 'audit-record' : 'snapshot-diff', read_method: source.command, coverage: source.coverage,
                batch_id: snapshot, current_snapshot: snapshot,
                ...(previous ? { previous_snapshot: previous.snapshot_id } : {}),
                observed_between: { after: previous?.started_at ?? null, by: entry.observedAt },
              },
              related, evidence: entry.evidence,
            }
            append.run(event_id, source.source_id, source.type, entry.id, JSON.stringify(event))
          }
          save.run(source.source_id, entry.id, snapshot, snapshot, entry.startedAt, entry.observedAt,
            JSON.stringify(fields), JSON.stringify(entry.evidence))
        }
        if (accepted < entries.length) {
          health = accepted ? 'partial' : 'stale'
          reason = 'some provider revisions predate their accepted snapshots'
          counts = { ...counts, observed: accepted, stale: entries.length - accepted }
        }
        this.db.prepare(`
          UPDATE sources SET last_attempt_at = ?, health = ?, reason = ?, counts = ?,
            last_snapshot_id = COALESCE(?, last_snapshot_id), last_success_at = COALESCE(?, last_success_at)
          WHERE source_id = ?
        `).run(observedAt, health, reason, JSON.stringify(counts), accepted ? snapshot : null,
          accepted ? observedAt : null, source.source_id)
      } else health = 'stale'
      this.db.exec('COMMIT')
      return health === 'ok' || health === 'unconnected'
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  recordAttempt(observation) {
    return this.recordAttempts([observation])[0]
  }

  recordAttempts(observations) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const batchIds = { task: randomUUID(), fleet: randomUUID() }
      const selectFleet = this.db.prepare('SELECT * FROM fleet_windows WHERE home_id = ?')
      const priorFleetWindows = new Map(observations.filter(({ source }) => source.type === 'worker')
        .map(({ source }) => [source.home_id, selectFleet.get(source.home_id)]))
      const results = observations.map(observation =>
        this.#recordAttempt(observation, batchIds, selectFleet, priorFleetWindows.get(observation.source.home_id)))
      this.db.exec('COMMIT')
      return results
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  #recordAttempt(observation, batchIds, selectFleet, priorFleetWindow) {
    const { source, started_at, observed_at, entries, generated_at } = observation
    let batchObservedAt = observed_at
    const previous = this.db.prepare('SELECT * FROM sources WHERE source_id = ?').get(source.source_id)
    // Registration is separate so the tail can show pending sources even if
    // they have never completed a read.
    if (!previous) throw new Error('observation source was not registered')
    let written = 0
    let complete = false
    const overlapsAcceptedWindow = started_at < (previous.last_success_at ?? '')
    let { health, reason = null, counts = null } = observation
    let snapshotId = null
    const fleetWindow = selectFleet.get(source.home_id)
    const pr = source.type === 'task' ? observation.pullRequests : null
    const worker = pr && this.db.prepare(`
      SELECT last_success_at, last_generated_at
      FROM sources WHERE source_id = ?
    `).get(entityId('home', source.home_id, 'worker'))
    const fresh = pr && pr.observed_at >= pr.started_at &&
      pr.started_at >= (worker?.last_success_at ?? '') &&
      freshFleet(pr, fleetWindow, previous.last_generated_at) &&
      pr.generated_at > (worker?.last_generated_at ?? '')
    const backlogAbsent = fresh && pr.backlogAbsent
    if (backlogAbsent) counts = { ...counts, fleet_backlog_absent: 1 }
    let acceptedFleet = backlogAbsent ? pr : null
    if (observed_at < started_at) {
      health = 'stale'
      reason = 'read ended before it started'
      batchObservedAt = previous.last_attempt_at
    } else if (entries && overlapsAcceptedWindow) {
      health = 'stale'
      reason = 'read overlaps the accepted collection window'
    } else if (entries && generated_at && !freshFleet(observation, fleetWindow, previous.last_generated_at, true)) {
      health = 'stale'
      reason = 'fleet watermark did not advance'
    } else if (entries && (health === 'ok' ||
      (source.type === 'worker' && health === 'partial' && observation.inventory_complete))) {
      snapshotId = randomUUID()
      if (generated_at) acceptedFleet = observation
      if (source.type === 'task') {
        const canJoinLinks = fresh && pr.started_at >= observed_at
        const projected = withPullRequests(entries, canJoinLinks ? pr.links : null)
        const pr_links_unobserved = projected.filter(entry => entry.evidence.pr_link_coverage === 'unobserved').length
        if (pr_links_unobserved) counts = { ...counts, pr_links_unobserved }
        if (canJoinLinks && pr_links_unobserved < entries.length) acceptedFleet = pr
        observation = { ...observation, entries: projected }
      }
      const previousWorkerStartedAt = source.type === 'worker'
        ? [fleetWindow, priorFleetWindow].find(window => window &&
          window.observed_at === previous.last_success_at && window.generated_at === previous.last_generated_at)?.started_at
        : null
      written = this.recordEntries(observation, previous, snapshotId, batchIds, previousWorkerStartedAt)
      complete = health === 'ok' && !counts?.pr_links_unobserved && !counts?.fleet_backlog_absent
    }
    if (acceptedFleet) {
      this.db.prepare(`
        INSERT INTO fleet_windows (home_id, started_at, observed_at, generated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(home_id) DO UPDATE SET started_at = excluded.started_at,
          observed_at = excluded.observed_at, generated_at = excluded.generated_at
      `).run(source.home_id, acceptedFleet.started_at, acceptedFleet.observed_at, acceptedFleet.generated_at)
    }
    this.db.prepare(`
      UPDATE sources SET last_attempt_at = ?, health = ?, reason = ?,
        counts = ?, last_snapshot_id = COALESCE(?, last_snapshot_id),
        last_success_at = COALESCE(?, last_success_at),
        last_generated_at = COALESCE(?, last_generated_at)
      WHERE source_id = ?
    `).run(batchObservedAt, health, reason, JSON.stringify(counts),
      snapshotId, snapshotId ? batchObservedAt : null,
      acceptedFleet?.generated_at ?? null, source.source_id)
    return { written, complete }
  }

  recordEntries(observation, previous, snapshotId, batchIds, previousWorkerStartedAt) {
    const previousSnapshot = previous.last_snapshot_id
    const { source, started_at, observed_at } = observation
    const isWorker = source.type === 'worker'
    const previousCounts = isWorker ? JSON.parse(previous.counts) : null
    const priorInventoryEstablishesAbsence = previous.last_attempt_at === previous.last_success_at &&
      previousCounts?.secondmate_without_generation === 0 &&
      (previous.health === 'ok' || (previous.health === 'partial' && previousCounts.current_state_unavailable > 0))
    const priorWorkerAbsence = {
      snapshot: priorInventoryEstablishesAbsence ? previousSnapshot : null,
      startedAt: priorInventoryEstablishesAbsence ? previousWorkerStartedAt : null,
    }
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
    const append = this.db.prepare(insertEvent)
    const saveWorker = isWorker ? this.db.prepare(`
      INSERT INTO worker_samples (source_id, entity_id, snapshot_id, observed_at, current_state, reason, evidence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, entity_id) DO UPDATE SET snapshot_id = excluded.snapshot_id,
        observed_at = excluded.observed_at, current_state = excluded.current_state,
        reason = excluded.reason, evidence = excluded.evidence
    `) : null
    const selectWorker = isWorker ? this.db.prepare(`
      SELECT snapshot_id, evidence FROM worker_samples WHERE source_id = ? AND entity_id = ?
    `) : null
    let count = 0
    const publish = (entry, difference, context) => {
      const pullRequestChange = difference.change.field === 'pull_requests'
      const taskObserved = difference.event_type === 'task.observed'
      const eventObservedAt = pullRequestChange ? observation.pullRequests.observed_at : observed_at
      const { evidence } = entry
      const previousEvidence = context.evidence
      const { snapshot = previousSnapshot } = context
      const envelope = {
        schema: 'event-publisher.event.v1',
        event_id: `event:${randomUUID()}`,
        ...difference,
        source: { provider: 'firstmate', source_id: source.source_id, home_id: source.home_id, mode: source.mode },
        subject: { type: source.type, id: entry.id },
        observed_at: eventObservedAt,
        occurred_at: null,
        observation: {
          method: 'snapshot-diff',
          read_method: pullRequestChange ? 'fleet-snapshot' : observation.method ?? 'fleet-snapshot',
          coverage: source.coverage,
          batch_id: pullRequestChange || isWorker ? batchIds.fleet : batchIds.task,
          ...(snapshot === null ? {} : { previous_snapshot: snapshot }),
          current_snapshot: snapshotId,
          observed_between: { after: context.startedAt ?? null, by: eventObservedAt },
        },
        related: this.relationships(source, entry, started_at),
        evidence: {
          source_reference: { interface: pullRequestChange ? fleetCommand : source.command, task_id: evidence.task_id,
            ...(evidence.spawn_gen ? { spawn_gen: evidence.spawn_gen } : {}) },
          state_source: pullRequestChange ? prLinkSource : evidence.state_source,
          ...(previousEvidence ? { previous_state_source: pullRequestChange ? prLinkSource : previousEvidence.state_source } : {}),
          ...(!taskObserved && evidence.pr_link_coverage ? { pr_link_coverage: evidence.pr_link_coverage } : {}),
          ...(!taskObserved && evidence.pr_link_source ? { pr_link_source: evidence.pr_link_source } : {}),
          ...(isWorker ? { historical_last_event: evidence.historical_last_event } : {}),
          confidence_basis: context.basis,
        },
      }
      append.run(envelope.event_id, source.source_id, source.type, entry.id, JSON.stringify(envelope))
      count++
    }
    const entries = [...observation.entries].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    for (const entry of entries) {
      const prior = select.get(source.source_id, entry.id)
      const sample = selectWorker?.get(source.source_id, entry.id)
      const before = prior?.fields ? JSON.parse(prior.fields) : null
      const fields = entry.fields ? JSON.stringify({ ...before, ...entry.fields }) : null
      const previousEvidence = prior?.evidence ? JSON.parse(prior.evidence) : null
      const rebaselinePullRequests = !isWorker && before && Object.hasOwn(entry.fields, 'pull_requests') &&
        (previous.health !== 'ok' || previous.last_attempt_at !== previous.last_success_at ||
          prior.last_seen_snapshot !== previousSnapshot || !Object.hasOwn(before, 'pull_requests') ||
          previousEvidence?.pr_link_source !== prLinkSource)
      const evidence = {
        ...entry.evidence,
        ...(rebaselinePullRequests ? { pr_link_coverage: 'rebaselined' } : {}),
      }
      if (previousSnapshot) {
        const context = {
          snapshot: prior?.snapshot_id ?? prior?.last_seen_snapshot,
          startedAt: prior?.started_at,
          evidence: previousEvidence,
          basis: before ? 'field differs across verified observations' : 'first seen after the initial inventory',
        }
        if (isWorker && !prior) {
          const { current_state, reason } = entry.sample
          publish(entry, {
            event_type: 'worker.observed',
            change: { after: { current_state, ...(reason ? { reason } : {}) } },
          }, { ...priorWorkerAbsence, basis: context.basis })
        }
        if (isWorker && prior && (sample?.snapshot_id ?? prior.last_seen_snapshot) !== previousSnapshot) {
          publish(entry, {
            event_type: 'worker.inventory.entered',
            change: { field: 'inventory_membership', before: 'absent', after: 'present' },
          }, { ...priorWorkerAbsence, basis: 'present after absence from the accepted worker inventory' })
        }
        if ((!isWorker || prior) && fields && fields !== prior?.fields) {
          let previousFields = before
          if (isWorker && !before) {
            previousFields = { current_state: 'unknown' }
            context.evidence = sample ? JSON.parse(sample.evidence) : null
            context.startedAt = context.evidence?.started_at ??
              (prior.last_seen_snapshot === previousSnapshot ? previousWorkerStartedAt : null)
            context.basis = 'first verified state after an unknown sample'
          }
          for (const difference of eventChanges(source.type, previousFields, entry.fields)) {
            if (difference.change.field === 'pull_requests' && rebaselinePullRequests) continue
            publish({ ...entry, evidence }, difference, context)
          }
        }
      }
      // Keep membership samples even when the state cannot be verified.
      saveWorker?.run(source.source_id, entry.id, snapshotId, observed_at,
        entry.sample.current_state, entry.sample.reason, JSON.stringify({ ...evidence, started_at }))
      save.run(source.source_id, entry.id, snapshotId, fields ? snapshotId : null,
        fields ? started_at : null, fields ? observed_at : null, fields,
        fields ? JSON.stringify(evidence) : null)
    }
    if (isWorker && previousSnapshot) {
      const unresolved = new Set(observation.unresolved_task_ids)
      const retainMembership = this.db.prepare(`
        UPDATE worker_samples SET snapshot_id = ? WHERE source_id = ? AND entity_id = ?
      `)
      const departed = this.db.prepare(`
        SELECT w.entity_id, w.evidence, e.last_seen_snapshot
        FROM worker_samples w JOIN entities e USING (source_id, entity_id)
        WHERE w.source_id = ? AND w.snapshot_id = ? ORDER BY w.entity_id
      `).all(source.source_id, previousSnapshot)
      for (const sample of departed) {
        const evidence = JSON.parse(sample.evidence)
        if (unresolved.has(evidence.task_id)) {
          retainMembership.run(snapshotId, source.source_id, sample.entity_id)
          continue
        }
        publish({ id: sample.entity_id, evidence: { ...evidence, state_source: null, historical_last_event: null } }, {
          event_type: 'worker.inventory.left',
          change: { field: 'inventory_membership', before: 'present', after: 'absent' },
        }, { snapshot: sample.last_seen_snapshot, startedAt: evidence.started_at ??
            (sample.last_seen_snapshot === previousSnapshot ? previousWorkerStartedAt : null),
          evidence, basis: 'absent from the next accepted worker inventory' })
      }
    }
    return count
  }

  relationships(source, entry, startedAt) {
    if (source.type !== 'worker') return entry.related
    const taskSource = entityId('home', source.home_id, 'task')
    const taskId = entityId('task', source.home_id, entry.evidence.task_id)
    const task = this.db.prepare(`
      SELECT 1 FROM entities e JOIN sources s USING (source_id)
      WHERE e.source_id = ? AND e.entity_id = ? AND e.last_seen_snapshot = s.last_snapshot_id
        AND s.health = 'ok' AND json_extract(s.description, '$.mode') = ?
        AND s.last_success_at <= ?
    `).get(taskSource, taskId, source.mode, startedAt)
    return task ? [{ relation: 'executes', subject: { type: 'task', id: taskId } }] : []
  }

  sources() {
    return this.db.prepare(`
      SELECT description, counts, last_attempt_at, last_snapshot_id, last_success_at,
        last_generated_at, health, reason
      FROM sources ORDER BY source_id
    `).all().map(row => {
      const { description, counts: rawCounts, ...health } = row
      const { configured = 1, ...source } = JSON.parse(description)
      if (!configured) return { ...source, ...health, health: 'deconfigured', reason: null, counts: null }
      const counts = rawCounts ? JSON.parse(rawCounts) : null
      if (health.health === 'ok' && counts?.fleet_backlog_absent) {
        return { ...source, ...health, health: 'partial', reason: 'fleet snapshot backlog absent', counts }
      }
      return { ...source, ...health, counts }
    })
  }

  tail() {
    return this.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS n FROM events').get().n
  }

  registerRelay({ name, stream, startAfter }) {
    if (startAfter > this.tail()) {
      throw new JournalConfigurationError('startAfter exceeds the current journal tip')
    }
    this.db.prepare(`
      INSERT INTO jetstream_relays (name, stream, sequence) VALUES (?, ?, ?)
      ON CONFLICT(name) DO NOTHING
    `).run(name, stream, startAfter)
    const row = this.db.prepare('SELECT stream, sequence FROM jetstream_relays WHERE name = ?').get(name)
    if (row.stream !== stream) {
      throw new JournalConfigurationError('use a distinct relay name when changing the destination stream')
    }
    return row.sequence
  }

  updateRelay(name, sequence, health, reason = null, ackAt = null) {
    try {
      this.db.prepare(`
        UPDATE jetstream_relays
        SET sequence = MAX(sequence, ?), health = ?, reason = ?,
            last_ack_at = COALESCE(?, last_ack_at), updated_at = ?
        WHERE name = ?
      `).run(sequence, health, reason, ackAt, new Date().toISOString(), name)
    } catch {
      throw new RelayCheckpointError(`JetStream relay ${name} could not save checkpoint at journal #${sequence} (state ${health})`)
    }
  }

  relayStatus() {
    const present = this.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'jetstream_relays'").get()
    return present ? this.db.prepare('SELECT * FROM jetstream_relays ORDER BY name').all() : []
  }

  inspect(id) {
    return readEvent(this.db.prepare('SELECT sequence, envelope FROM events WHERE event_id = ?').get(id))
  }

  cursorBeforeLast(through, count, { type, entity, provider }) {
    const row = this.db.prepare(`
      SELECT sequence FROM events
      WHERE sequence <= ?
        AND (? IS NULL OR subject_type = ?)
        AND (? IS NULL OR subject_id = ?)
        AND (? IS NULL OR source_id GLOB ?)
      ORDER BY sequence DESC LIMIT 1 OFFSET ?
    `).get(through, type ?? null, type ?? null, entity ?? null, entity ?? null,
      provider ?? null, provider ? `${provider}:*` : null, count - 1)
    return row ? row.sequence - 1 : 0
  }

  events({ after = 0, through = Number.MAX_SAFE_INTEGER, limit = 100, type, entity, provider } = {}) {
    const rows = this.db.prepare(`
      SELECT sequence, envelope FROM events
      WHERE sequence > ? AND sequence <= ?
        AND (? IS NULL OR subject_type = ?)
        AND (? IS NULL OR subject_id = ?)
        AND (? IS NULL OR source_id GLOB ?)
      ORDER BY sequence LIMIT ?
    `).all(after, through, type ?? null, type ?? null, entity ?? null, entity ?? null,
      provider ?? null, provider ? `${provider}:*` : null, limit)
    return rows.map(readEvent)
  }
}

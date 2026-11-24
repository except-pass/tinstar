import { createHash } from 'node:crypto'

export const migrationSourceId = 'routing:mate-migration'

export function migrationSource() {
  return {
    source_id: migrationSourceId, provider: 'routing', type: 'mate', home_path: null,
    coverage: 'operator-recorded mate migrations',
  }
}

const isText = value => typeof value === 'string' && value.length > 0 && value.trim() === value &&
  !/[\u0000-\u001f\u007f]/u.test(value) && value.isWellFormed()

function route(context) {
  const { machine, runtime, provider } = context ?? {}
  if ([machine, runtime, provider].every(isText)) return { machine, runtime, provider }
}

function instant(value) {
  // Require a timezone so two operators cannot record different cutoffs from the same input.
  if (typeof value !== 'string') return null
  const match = /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):\d\d(?::\d\d(?:\.(\d+))?)?(?:Z|[+-]\d\d:\d\d)$/.exec(value)
  if (!match) return null
  const date = value.slice(0, 10)
  const midnight = new Date(date)
  if (Number.isNaN(midnight.getTime()) || midnight.toISOString().slice(0, 10) !== date) return null
  const utc = new Date(value)
  if (Number.isNaN(utc.getTime())) return null
  // Keep sub-millisecond digits used by source clocks when normalizing to UTC.
  const fraction = (match[1] ?? '').replace(/0+$/, '').padEnd(3, '0')
  return `${utc.toISOString().slice(0, -5)}.${fraction}Z`
}

function beforeInstant(a, b) {
  const ms = Date.parse(a) - Date.parse(b)
  return ms === 0 ? a.slice(a.indexOf('.'), -1) < b.slice(b.indexOf('.'), -1) : ms < 0
}

const routeKey = ({ machine, runtime, provider }) => JSON.stringify([machine, runtime, provider])

export class MigrationReceiptError extends Error {}

export function migrationReceipt(input, observedAt) {
  const { mate_id, effective_start_at, recorded_by, source_reference, controlled = false } = input ?? {}
  const before = route(input?.old)
  const after = route(input?.new)
  const occurred_at = instant(effective_start_at)
  if (!isText(mate_id) || !before || !after || !occurred_at ||
      !isText(recorded_by) || !isText(source_reference) || typeof controlled !== 'boolean') {
    throw new MigrationReceiptError('receipt needs mate_id, old and new machine/runtime/provider, effective_start_at with timezone, recorded_by and source_reference; controlled is a boolean')
  }
  if (routeKey(before) === routeKey(after)) {
    throw new MigrationReceiptError('old and new routing contexts must differ')
  }
  const identity = JSON.stringify([mate_id, before, after, occurred_at])
  const event_id = `event:${createHash('sha256').update(identity).digest('hex')}`
  return {
    schema: 'event-publisher.event.v1',
    event_type: 'mate.migration.recorded',
    event_id,
    source: { provider: 'routing', source_id: migrationSourceId, mode: controlled ? 'fixture' : 'live' },
    subject: { type: 'mate', id: mate_id },
    observed_at: observedAt,
    occurred_at,
    effective_start_at: occurred_at,
    observation: { method: 'manual', read_method: 'local-cli', coverage: migrationSource().coverage },
    related: [],
    change: { field: 'routing_context', before, after },
    evidence: {
      source_reference: { interface: 'events record-migration', reference: source_reference, recorded_by },
      confidence_basis: controlled ? 'controlled proof' : 'operator-reported migration',
    },
  }
}

export function routingReplayCheck(receipts) {
  const ordered = [...receipts].sort((a, b) => {
    if (a.effective_start_at === b.effective_start_at) return 0
    return beforeInstant(a.effective_start_at, b.effective_start_at) ? -1 : 1
  })
  const groups = new Map()
  for (const receipt of ordered) {
    const oldKey = routeKey(receipt.change.before)
    const newKey = routeKey(receipt.change.after)
    const key = JSON.stringify([receipt.subject.id, receipt.effective_start_at])
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ receipt, oldKey, newKey })
  }
  const timelines = new Map()
  for (const group of groups.values()) {
    const mate = group[0].receipt.subject.id
    if (!timelines.has(mate)) timelines.set(mate, [])
    const timeline = timelines.get(mate)
    while (group.length) {
      const previous = timeline.at(-1)
      const linked = group.findIndex(({ oldKey }) => oldKey === previous?.key)
      const root = linked < 0 ? group.findIndex(({ oldKey }) =>
        !group.some(({ newKey }) => newKey === oldKey)) : linked
      const [{ receipt, oldKey, newKey }] = group.splice(Math.max(root, 0), 1)
      if (!previous) timeline.push({ key: oldKey, start: null })
      else if (previous.key !== oldKey && previous.start.effective_start_at !== receipt.effective_start_at) {
        previous.uncoveredUntil = receipt
      }
      timeline.push({ key: newKey, start: receipt })
    }
  }
  return row => {
    if (!isText(row?.mate_id)) return null
    const timestamp = instant(row.occurred_at)
    const timeline = timelines.get(row.mate_id)
    if (!timestamp || !timeline) return null
    const gap = timeline.find(({ start, uncoveredUntil }) => uncoveredUntil &&
      !beforeInstant(timestamp, start.effective_start_at) &&
      beforeInstant(timestamp, uncoveredUntil.effective_start_at))
    if (gap) {
      return {
        warning: 'routing.uncovered_timestamp_excluded',
        observation_id: row.observation_id,
        mate_id: row.mate_id,
        occurred_at: row.occurred_at,
        previous_migration_event_id: gap.start.event_id,
        next_migration_event_id: gap.uncoveredUntil.event_id,
      }
    }
    const context = route(row.route)
    if (!context || !isText(row.observation_id)) return null
    const key = routeKey(context)
    let receipt
    for (const [index, { key: intervalKey, start }] of timeline.entries()) {
      if (intervalKey !== key) continue
      const end = timeline[index + 1]?.start
      if (start && beforeInstant(timestamp, start.effective_start_at)) {
        receipt = start
        break
      }
      if (!end || beforeInstant(timestamp, end.effective_start_at)) return null
      receipt = end
    }
    if (!receipt) return null
    return {
      warning: 'routing.historical_timestamp_excluded',
      observation_id: row.observation_id,
      mate_id: row.mate_id,
      route: context,
      occurred_at: row.occurred_at,
      effective_start_at: receipt.effective_start_at,
      migration_event_id: receipt.event_id,
    }
  }
}

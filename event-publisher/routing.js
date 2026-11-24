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

const routeKey = (mate, { machine, runtime, provider }) => JSON.stringify([mate, machine, runtime, provider])

export function routingReplayCheck(receipts) {
  const cutoffs = new Map()
  for (const receipt of receipts) {
    const key = routeKey(receipt.subject.id, receipt.change.after)
    const existing = cutoffs.get(key)
    if (!existing || beforeInstant(existing.effective_start_at, receipt.effective_start_at)) cutoffs.set(key, receipt)
  }
  return row => {
    const context = route(row?.route)
    if (!context || !isText(row.mate_id) || !isText(row.observation_id)) return null
    const receipt = cutoffs.get(routeKey(row.mate_id, context))
    if (!receipt) return null
    const timestamp = instant(row.occurred_at)
    if (!timestamp || !beforeInstant(timestamp, receipt.effective_start_at)) return null
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

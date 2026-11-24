import { hostname } from 'node:os'

const shaPattern = /^[a-f0-9]{40}$/
const floorUrl = 'http://127.0.0.1:5281/api/deployment'
const floorTarget = `tinstar-floor:${encodeURIComponent(hostname())}:5281`
export const deploymentSource = {
  source_id: `deployment:${floorTarget}`, provider: 'deployment', type: 'deployment', mode: 'live', home_path: null,
  coverage: 'Tin Star floor running revision',
  command: 'loopback GET /api/deployment',
}

export const deploymentLifecycleSource = {
  source_id: 'deployment:lifecycle', provider: 'deployment', type: 'deployment', health: 'unconnected',
  coverage: 'deployment attempts, smoke, failure and rollback',
  reason: 'the deploy audit is an owner-only file on the deployment host and the publisher has no read-only reader there',
}

function auditTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null
  const time = value.length === 20 ? value.replace('Z', '.000Z') : value
  const date = new Date(time)
  return Number.isFinite(date.getTime()) && date.toISOString() === time ? time : null
}

export function parseFloorAudit(jsonl, { target, failureMarker = '' }) {
  const observations = new Map()
  function add(time, lifecycle, action, revision, nativeId, extra = {}) {
    const occurredAt = auditTime(time)
    if (!occurredAt) return
    const id = `deployment:${encodeURIComponent(target)}:${nativeId ?? revision ?? 'block'}`
    const event_type = `deployment.${lifecycle}`
    const key = JSON.stringify([id, event_type, occurredAt])
    if (observations.has(key)) return
    observations.set(key, {
      id, event_type, occurredAt,
      fields: { environment: 'floor', revision, lifecycle, native_deployment_id: nativeId, ...extra },
      evidence: { source_reference: { target, action }, confidence_basis: 'guarded floor deployment record' },
    })
  }

  for (const line of jsonl.split('\n')) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const { action, time, newSha, head, gate } = row ?? {}
    if (action === 'floor-deployment' && typeof newSha === 'string' &&
        shaPattern.test(newSha) && row.id === `floor:${newSha}`) {
      add(time, 'started', action, newSha, row.id)
    } else if (action === 'floor-smoke' && row.passed === true && typeof newSha === 'string' &&
        shaPattern.test(newSha) && row.deploymentId === `floor:${newSha}`) {
      add(time, 'smoke_passed', action, newSha, row.deploymentId)
    } else if (gate === 'block' && action === 'clear-block') {
      add(time, 'block_clear_requested', action, null, null, {
        checkout_revision: typeof head === 'string' && shaPattern.test(head) ? head : null,
      })
    }
  }

  const marker = /^failed_at=([^\r\n]+)\r?\nphase=([\w.@:\\-]+)\r?\nsha=([a-f0-9]{40})(?:\r?\n)?$/.exec(failureMarker)
  if (marker) add(marker[1], 'gate_failed', 'failure-marker', marker[3], null, { phase: marker[2] })
  return [...observations.values()].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
}

export function deploymentDiff(before, after) {
  if (!before) return { changes: [{ event_type: 'deployment.running.observed', change: { after } }] }
  if (before.revision === after.revision) return { changes: [] }
  return { changes: [{
    event_type: 'deployment.revision.changed',
    change: { field: 'revision', before: before.revision, after: after.revision },
  }] }
}

export async function observeFloor(journal, signal, { fetchFloor = fetch, now = () => new Date() } = {}) {
  const startedAt = now().toISOString()
  const timeout = AbortSignal.timeout(5000)
  let revision, reason
  try {
    const response = await fetchFloor(floorUrl, {
      redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    if (response.ok) {
      const body = await response.json()
      if (body?.ok === true && typeof body.data?.sha === 'string' && shaPattern.test(body.data.sha)) {
        revision = body.data.sha
      } else reason = 'floor endpoint did not identify a running revision'
    } else {
      await response.body?.cancel()
      reason = `floor endpoint returned HTTP ${response.status}`
    }
  } catch {
    reason = 'floor revision endpoint could not be read'
  }
  if (signal?.aborted) return
  const observedAt = now().toISOString()
  const entries = revision ? [{
    // The endpoint identifies an exact target and build. It has no attempt ID.
    id: `deployment:${floorTarget}`,
    startedAt, observedAt,
    fields: { environment: 'floor', revision, lifecycle: 'running', native_deployment_id: null },
    related: [],
    evidence: {
      source_reference: { endpoint: floorUrl, target: floorTarget },
      confidence_basis: 'build SHA reported by the running Tin Star floor',
    },
  }] : []
  return journal.recordProviderPoll(deploymentSource, {
    startedAt, observedAt, entries, health: revision ? 'ok' : 'unavailable',
    reason: reason ?? null, counts: { observed: entries.length },
  }, deploymentDiff)
}

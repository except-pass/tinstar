import { hostname } from 'node:os'

const floorUrl = 'http://127.0.0.1:5281/api/deployment'
const floorTarget = `tinstar-floor:${encodeURIComponent(hostname())}:5281`
export const deploymentSource = {
  source_id: `deployment:${floorTarget}`, provider: 'deployment', type: 'deployment', mode: 'live', home_path: null,
  coverage: 'Tin Star floor running revision; deployment attempts and lifecycle unavailable',
  command: 'loopback GET /api/deployment',
}

export function deploymentDiff(before, after) {
  if (!before) return [{ event_type: 'deployment.running.observed', change: { after } }]
  if (before.revision === after.revision) return []
  return [{
    event_type: 'deployment.revision.changed',
    change: { field: 'revision', before: before.revision, after: after.revision },
  }]
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
      if (body?.ok === true && typeof body.data?.sha === 'string' && /^[a-f0-9]{40}$/.test(body.data.sha)) {
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

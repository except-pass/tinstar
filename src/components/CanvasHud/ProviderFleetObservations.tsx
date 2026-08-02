import type {
  ManagedProviderSessionWire,
  ProviderCurrentObservationsWire,
  ProviderSessionUsageObservationWire,
} from '../../domain/provider-observation-wire'
import { providerSessionTokenTotal } from '../../domain/provider-capabilities'
import { fmtRate } from './fmt'

interface Props {
  observations: ProviderCurrentObservationsWire
  managedSessions: readonly ManagedProviderSessionWire[]
  error?: string | null
}

interface ProviderFleetRow {
  providerId: string
  sessionCount: number
  unavailableCount: number
  totalTokens: number | null
  models: string[]
  sources: string[]
  freshness: 'fresh' | 'stale' | 'unknown'
}

export function ProviderFleetObservations({ observations, managedSessions, error }: Props) {
  const rows = buildProviderFleetRows(observations.sessionUsage, managedSessions)
  if (rows.length === 0 && !error) return null

  return (
    <section data-testid="provider-fleet-observations" style={{ display: 'grid', gap: 5 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        fontSize: 8, letterSpacing: 1.4, color: 'rgba(255,255,255,0.48)',
      }}>
        <span>PROVIDER SIGNALS</span>
        {error && <span style={{ color: '#fca5a5', letterSpacing: 0 }}>refresh failed</span>}
      </div>
      {rows.map(row => (
        <div
          key={row.providerId}
          data-testid={`provider-fleet-row-${row.providerId}`}
          style={{
            display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8,
            padding: '5px 7px', borderRadius: 4,
            background: 'rgba(34,211,238,0.055)',
            borderLeft: '2px solid rgba(34,211,238,0.55)',
          }}
          title={row.sources.length > 0 ? `Sources: ${row.sources.join(', ')}` : undefined}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{
              display: 'flex', gap: 5, alignItems: 'baseline',
              fontSize: 9, color: '#cbd5e1', fontWeight: 700,
            }}>
              <span>{formatProviderLabel(row.providerId)}</span>
              <span style={{ color: freshnessColor(row.freshness), fontSize: 7.5, fontWeight: 400 }}>
                {row.freshness}
              </span>
            </div>
            <div style={{
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              color: 'rgba(255,255,255,0.4)', font: "8px 'JetBrains Mono', monospace",
            }}>
              {row.sessionCount} session{row.sessionCount === 1 ? '' : 's'}
              {row.unavailableCount > 0 ? ` · ${row.unavailableCount} unavailable` : ''}
              {row.models.length > 0 ? ` · ${row.models.join(', ')}` : ''}
            </div>
          </div>
          <div style={{
            alignSelf: 'center', color: row.totalTokens === null ? '#94a3b8' : '#e2e8f0',
            font: "700 10px 'JetBrains Mono', monospace",
          }}>
            {row.totalTokens === null ? 'unavailable' : `${fmtRate(row.totalTokens)} tok`}
          </div>
        </div>
      ))}
    </section>
  )
}

export function buildProviderFleetRows(
  observations: readonly ProviderSessionUsageObservationWire[],
  managedSessions: readonly ManagedProviderSessionWire[],
): ProviderFleetRow[] {
  const grouped = new Map<string, {
    sessions: Set<string>
    unavailable: number
    totals: number[]
    models: Set<string>
    sources: Set<string>
    freshness: Set<'fresh' | 'stale' | 'unknown'>
  }>()

  const hostByAlias = new Map<string, string>()
  for (const session of managedSessions) {
    for (const providerSessionId of session.providerSessionIds) {
      hostByAlias.set(
        JSON.stringify([session.providerId, providerSessionId]),
        session.hostSessionId,
      )
    }
  }
  const currentByHost = new Map<string, ProviderSessionUsageObservationWire>()
  for (const observation of observations) {
    const hostSessionId = hostByAlias.get(JSON.stringify([
      observation.providerId,
      observation.scope.sessionId,
    ]))
    if (!hostSessionId) continue
    const key = JSON.stringify([observation.providerId, hostSessionId])
    const existing = currentByHost.get(key)
    if (!existing || observationTimestamp(observation) >= observationTimestamp(existing)) {
      currentByHost.set(key, observation)
    }
  }

  for (const [hostKey, observation] of currentByHost) {
    const [, hostSessionId] = JSON.parse(hostKey) as [string, string]
    let group = grouped.get(observation.providerId)
    if (!group) {
      group = {
        sessions: new Set(),
        unavailable: 0,
        totals: [],
        models: new Set(),
        sources: new Set(),
        freshness: new Set(),
      }
      grouped.set(observation.providerId, group)
    }
    group.sessions.add(hostSessionId)
    group.freshness.add(observation.freshness.state)
    if (observation.source) group.sources.add(observation.source.label)
    if (observation.availability.state !== 'available') {
      group.unavailable += 1
      continue
    }
    const { value } = observation.availability
    if (value.model) group.models.add(value.model)
    const total = providerSessionTokenTotal(value)
    if (total !== null) group.totals.push(total)
  }

  return [...grouped.entries()]
    .map(([providerId, group]) => ({
      providerId,
      sessionCount: group.sessions.size,
      unavailableCount: group.unavailable,
      totalTokens: group.totals.length > 0
        ? group.totals.reduce((sum, value) => sum + value, 0)
        : null,
      models: [...group.models].sort(),
      sources: [...group.sources].sort(),
      freshness: group.freshness.has('stale')
        ? 'stale' as const
        : group.freshness.has('fresh')
          ? 'fresh' as const
          : 'unknown' as const,
    }))
    .sort((left, right) => left.providerId.localeCompare(right.providerId))
}

function observationTimestamp(observation: ProviderSessionUsageObservationWire): number {
  const at = observation.freshness.observedAt ?? observation.freshness.checkedAt
  const parsed = Date.parse(at)
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY
}

function formatProviderLabel(providerId: string): string {
  return providerId
    .split(/[._-]+/u)
    .filter(Boolean)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function freshnessColor(freshness: ProviderFleetRow['freshness']): string {
  if (freshness === 'stale') return '#fbbf24'
  if (freshness === 'unknown') return '#f87171'
  return '#67e8f9'
}

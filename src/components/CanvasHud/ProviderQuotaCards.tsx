import { useEffect, useState } from 'react'
import type { ProviderAccountQuotaObservationWire } from '../../domain/provider-observation-wire'
import './hud.css'

const TICK_MS = 60_000

interface Props {
  observations: ProviderAccountQuotaObservationWire[]
  error?: string | null
  /** Injected for tests. */
  nowMs?: number
}

export function ProviderQuotaCards({ observations, error, nowMs }: Props) {
  const now = useMinuteClock(nowMs)

  if (observations.length === 0 && !error) return null

  return (
    <div className="provider-quota-list" data-testid="provider-quota-list">
      {error && (
        <div className="provider-quota-error" role="status">
          Quota refresh failed · {error}
        </div>
      )}
      {observations.map(observation => (
        <ProviderQuotaCard
          key={JSON.stringify([
            observation.providerId,
            observation.scope.accountRef,
          ])}
          observation={observation}
          nowMs={now}
          refreshError={error}
        />
      ))}
    </div>
  )
}

function ProviderQuotaCard({
  observation,
  nowMs,
  refreshError,
}: {
  observation: ProviderAccountQuotaObservationWire
  nowMs: number
  refreshError?: string | null
}) {
  const accountRef = observation.scope.accountRef
  const title = formatProviderLabel(observation.providerId)
  const source = observation.source?.label
  const freshness = refreshError ? 'refresh failed' : freshnessLabel(observation, nowMs)
  const availability = observation.availability
  const identity = `${observation.providerId} · ${accountRef}`

  return (
    <section
      className="provider-quota-card"
      data-testid={`provider-quota-card-${observation.providerId}-${accountRef}`}
      title={[identity, source, freshness, refreshError].filter(Boolean).join('\n')}
    >
      <div className="provider-quota-header">
        <span className="provider-quota-title">{title}</span>
        <span className="provider-quota-account">{accountRef}</span>
        <span className={`provider-quota-freshness provider-quota-freshness-${refreshError ? 'error' : observation.freshness.state}`}>
          {freshness}
        </span>
      </div>
      {source && <div className="provider-quota-source">{source}</div>}

      {availability.state === 'available' && availability.value.windows.length > 0
        ? availability.value.windows.map(window => {
            const usedPercent = Math.round(window.usedPercent)
            const remainingPercent = 100 - usedPercent
            return (
              <div className="provider-quota-row" key={window.id}>
                <QuotaGauge
                  label={window.label}
                  usedPercent={usedPercent}
                  remainingPercent={remainingPercent}
                />
                <div className="provider-quota-text">
                  <div className="provider-quota-big">
                    {remainingPercent}% left
                  </div>
                  <div className="provider-quota-sub">
                    {window.label} · {usedPercent}% used
                    {window.resetsAt ? ` · resets ${humanDuration(Date.parse(window.resetsAt) - nowMs)}` : ''}
                  </div>
                </div>
              </div>
            )
          })
        : availability.state === 'available'
          ? <QuotaState label="No quota windows reported" />
          : availability.state === 'unsupported'
            ? <QuotaState label={`Unsupported · ${availability.reason}`} />
            : (
                <QuotaState
                  label={`Unavailable · ${availability.message ?? formatReason(availability.reason)}`}
                />
              )}
    </section>
  )
}

function QuotaGauge({
  label,
  usedPercent,
  remainingPercent,
}: {
  label: string
  usedPercent: number
  remainingPercent: number
}) {
  return (
    <div
      className="provider-quota-gauge"
      role="img"
      aria-label={`${label}: ${usedPercent}% used, ${remainingPercent}% remaining`}
      style={{ '--quota-remaining': `${remainingPercent * 3.6}deg` } as React.CSSProperties}
    >
      <span>{remainingPercent}</span>
    </div>
  )
}

function QuotaState({ label }: { label: string }) {
  return <div className="provider-quota-state">{label}</div>
}

function useMinuteClock(nowMs: number | undefined): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (nowMs !== undefined) return
    const handle = setInterval(() => setTick(value => value + 1), TICK_MS)
    return () => clearInterval(handle)
  }, [nowMs])
  void tick
  return nowMs ?? Date.now()
}

function freshnessLabel(
  observation: ProviderAccountQuotaObservationWire,
  nowMs: number,
): string {
  const { freshness } = observation
  if (freshness.state === 'unknown') return 'unknown'
  return `${freshness.state} · ${ageLabel(Date.parse(freshness.observedAt), nowMs)}`
}

function formatProviderLabel(providerId: string): string {
  return providerId
    .split(/[._-]+/u)
    .filter(Boolean)
    .map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

function formatReason(reason: string): string {
  return reason.replaceAll('-', ' ')
}

function humanDuration(ms: number): string {
  if (ms <= 0) return 'now'
  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor((ms % 86_400_000) / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function ageLabel(lastMs: number, nowMs: number): string {
  const diffMinutes = Math.max(0, Math.floor((nowMs - lastMs) / 60_000))
  if (diffMinutes < 1) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const hours = Math.floor(diffMinutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

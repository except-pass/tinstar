import './hud.css'
import { CcQuotaClock } from './CcQuotaClock'
import { Cc7dBar } from './Cc7dBar'
import type { CcQuotaSnapshot, UsageBucket } from '../../hooks/useCcQuota'

interface Props {
  snapshot: CcQuotaSnapshot | null
  lastRefreshedAt: string | null
  refreshing: boolean
  refresh: () => void
  /** Injected for tests. */
  nowMs?: number
}

function pctLeft(bucket: UsageBucket | null): string {
  if (!bucket) return '--'
  return `${Math.max(0, Math.round(100 - bucket.utilization))}% left`
}

function humanDuration(ms: number): string {
  if (ms <= 0) return 'now'
  const hours = Math.floor(ms / 3_600_000)
  const mins  = Math.floor((ms % 3_600_000) / 60_000)
  if (hours <= 0) return `${mins}m`
  return `${hours}h ${mins}m`
}

function resetSubtitle(bucket: UsageBucket | null, nowMs: number): string {
  if (!bucket) return 'no data'
  const ms = Date.parse(bucket.resets_at) - nowMs
  return `resets ${humanDuration(ms)}`
}

function ageLabel(lastMs: number | null, nowMs: number): string {
  if (lastMs == null) return '—'
  const diffMin = Math.max(0, Math.floor((nowMs - lastMs) / 60_000))
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const h = Math.floor(diffMin / 60)
  return `${h}h ago`
}

function buildTooltip(s: CcQuotaSnapshot | null, nowMs: number): string {
  if (!s) return 'no data'
  const lines: string[] = []
  const d = s.data
  if (d?.five_hour) lines.push(`5H resets ${new Date(d.five_hour.resets_at).toLocaleTimeString()}`)
  if (d?.seven_day) lines.push(`7D resets ${new Date(d.seven_day.resets_at).toLocaleString()}`)
  lines.push(`Updated ${ageLabel(Date.parse(s.fetchedAt), nowMs)}`)
  if (s.error) lines.push(`⚠ ${s.error.code}: ${s.error.message}`)
  if (!d) lines.push('Waiting for Claude Code statusline push')
  return lines.join('\n')
}

export function CcQuotaCard({ snapshot, lastRefreshedAt, refreshing, refresh, nowMs }: Props) {
  const now = nowMs ?? Date.now()
  const data = snapshot?.data ?? null
  const tooltip = buildTooltip(snapshot, now)
  const lastMs = lastRefreshedAt ? Date.parse(lastRefreshedAt) : null
  const isError = !!snapshot?.error

  return (
    <div data-testid="cc-quota-card" className="cc-quota-card" title={tooltip}>
      <div className="cc-quota-header">
        <span className="cc-quota-title">Claude Code</span>
        <button
          type="button"
          className={`cc-quota-refresh${isError ? ' err' : ''}${refreshing ? ' spin' : ''}`}
          onClick={refresh}
          aria-label="refresh quota"
        >
          <span className="material-symbols-outlined">refresh</span>
          <span>{ageLabel(lastMs, now)}</span>
        </button>
      </div>

      <div className="cc-quota-row">
        <CcQuotaClock bucket={data?.five_hour ?? null} nowMs={now}/>
        <div className="cc-quota-text">
          <div className="cc-quota-big">{pctLeft(data?.five_hour ?? null)}</div>
          <div className="cc-quota-sub">5H · {resetSubtitle(data?.five_hour ?? null, now)}</div>
        </div>
      </div>

      <div className="cc-quota-row">
        <Cc7dBar bucket={data?.seven_day ?? null} nowMs={now}/>
        <div className="cc-quota-text">
          <div className="cc-quota-big">{pctLeft(data?.seven_day ?? null)}</div>
          <div className="cc-quota-sub">7D · {resetSubtitle(data?.seven_day ?? null, now)}</div>
        </div>
      </div>
    </div>
  )
}

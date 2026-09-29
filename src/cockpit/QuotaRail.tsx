import { useEffect, useState } from 'react'
import { Cc7dBar } from '../components/CanvasHud/Cc7dBar'
import { CcQuotaClock } from '../components/CanvasHud/CcQuotaClock'
import { ProviderQuotaCards } from '../components/CanvasHud/ProviderQuotaCards'
import { useProviderQuotaObservations } from '../hooks/providerObservationsStore'
import { useCcQuota, type UsageBucket } from '../hooks/useCcQuota'

const CLAUDE_STALE_MS = 5 * 60_000

function ageLabel(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

function resetLabel(bucket: UsageBucket, now: number): string {
  const reset = Date.parse(bucket.resets_at)
  if (!Number.isFinite(reset)) return 'reset unknown'
  const date = new Date(reset)
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return reset - now > 24 * 60 * 60_000
    ? `resets ${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
    : `resets ${time}`
}

function ClaudeWindow({ bucket, label, now }: { bucket: UsageBucket | null; label: '5H' | '7D'; now: number }) {
  const valid = bucket && Number.isFinite(bucket.utilization) && bucket.utilization >= 0 && bucket.utilization <= 100
  return <div className="cockpit-quota-row">
    <div className="cockpit-quota-visual">{label === '5H'
      ? <CcQuotaClock bucket={valid ? bucket : null} nowMs={now} />
      : <Cc7dBar bucket={valid ? bucket : null} nowMs={now} />}</div>
    <div className="cockpit-quota-copy"><strong>{label} · {valid ? `${Math.round(100 - bucket.utilization)}% left` : 'unavailable'}</strong>
      <small>{valid ? resetLabel(bucket, now) : 'No statusline reading'}</small></div>
  </div>
}

export function QuotaRail() {
  const { snapshot } = useCcQuota()
  const { observations, error, loaded } = useProviderQuotaObservations()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const fetchedAt = snapshot ? Date.parse(snapshot.fetchedAt) : NaN
  const current = Number.isFinite(fetchedAt) && now - fetchedAt < CLAUDE_STALE_MS && !snapshot?.error
  const claudeData = current ? snapshot?.data : null
  const claudeFreshness = !snapshot ? 'waiting for statusline'
    : snapshot.error ? `unavailable · ${snapshot.error.message}`
    : !Number.isFinite(fetchedAt) || !snapshot.data ? 'unavailable · no statusline reading'
    : !current ? `stale · ${ageLabel(fetchedAt, now)}`
    : `fresh · ${ageLabel(fetchedAt, now)}`
  const others = observations.filter(observation => observation.providerId !== 'claude')
  const observedProviders = new Set(others.map(observation => observation.providerId))

  return <section className="cockpit-quotas" aria-label="Provider quota">
    <div className="cockpit-quota-heading">PROVIDER QUOTA <span className="material-symbols-outlined" aria-hidden="true">speed</span></div>
    <div className="cockpit-quota-scroll">
      <section className="cockpit-quota-claude" aria-label="Claude provider quota">
        <div className="cockpit-quota-provider"><strong>Claude</strong><small>{claudeFreshness}</small></div>
        <ClaudeWindow bucket={claudeData?.five_hour ?? null} label="5H" now={now} />
        <ClaudeWindow bucket={claudeData?.seven_day ?? null} label="7D" now={now} />
      </section>
      <ProviderQuotaCards observations={others} error={error} nowMs={now} />
      {!observedProviders.has('codex') && <p className="cockpit-quota-missing"><strong>Codex</strong><span>Unavailable · no quota observation received</span></p>}
      {!observedProviders.has('grok') && <p className="cockpit-quota-missing"><strong>Grok</strong><span>Unavailable · no quota source connected</span></p>}
      {!loaded && <p className="cockpit-quota-missing">Loading provider observations…</p>}
    </div>
  </section>
}

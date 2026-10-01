import { useEffect, useState } from 'react'
import { useQuotaMeters } from '../hooks/useQuotaMeters'
import type { QuotaMeterProvider, QuotaMeterSnapshot, QuotaWindowReading } from '../server/quota/parse'
import { WeeklyStrip } from './WeeklyStrip'

const DAY_MS = 24 * 60 * 60_000

function providerName(id: string): string {
  if (id === 'claude') return 'Claude'
  if (id === 'codex') return 'Codex'
  if (id === 'grok') return 'Grok'
  return id.slice(0, 1).toUpperCase() + id.slice(1)
}

function formatWhen(iso: string | null, now: number): string {
  if (!iso) return 'unknown'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return 'unknown'
  const date = new Date(time)
  const clock = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return Math.abs(time - now) > DAY_MS
    ? `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock}`
    : clock
}

function ageLabel(iso: string | null, now: number): string {
  if (!iso) return 'unknown'
  const time = Date.parse(iso)
  if (!Number.isFinite(time)) return 'unknown'
  const minutes = Math.max(0, Math.floor((now - time) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`
}

function runOutLabel(provider: QuotaMeterProvider, now: number): string {
  if (provider.projectedRunOutAt) return formatWhen(provider.projectedRunOutAt, now)
  if (provider.runway === 'through_reset') return 'Through reset'
  return 'Not projected'
}

/** Marks already shipped in public/agent-icons for the old session templates. */
const PROVIDER_LOGO: Record<string, string> = {
  claude: '/agent-icons/claude.svg',
  codex: '/agent-icons/openai.svg',
  grok: '/agent-icons/grok.svg',
  cursor: '/agent-icons/cursor.svg',
}

function Glyph({ id }: { id: string }) {
  const logo = PROVIDER_LOGO[id]
  if (logo) return <img className="cockpit-quota-glyph" src={logo} alt="" />
  return <svg className="cockpit-quota-glyph" viewBox="0 0 16 16" aria-hidden="true"><text x="8" y="12" textAnchor="middle" fontSize="11" fill="currentColor">{id.slice(0, 1).toUpperCase()}</text></svg>
}

function shortReadout(window: QuotaWindowReading): string {
  const percent = window.remainingPercent == null ? '–' : String(window.remainingPercent)
  const name = window.id === 'five_hour' || window.label === 'session' ? '5h' : window.label
  return `${name} ${percent}`
}

function Detail({ provider, now }: { provider: QuotaMeterProvider; now: number }) {
  const remaining = provider.remainingPercent
  return <span className="cockpit-quota-popover" role="tooltip">
    <strong>{providerName(provider.id)}</strong>
    {provider.notSetUp ? <p>Not signed in. Sign in to Cursor to show quota.</p> : <dl>
      <dt>Remaining</dt><dd>{remaining == null ? '—' : `${remaining}%`}</dd>
      <dt>Limiting window</dt><dd>{provider.limitingWindow?.label ?? '—'}</dd>
      <dt>Resets</dt><dd><time dateTime={provider.limitingWindow?.resetsAt ?? undefined}>{formatWhen(provider.limitingWindow?.resetsAt ?? null, now)}</time></dd>
      <dt>Runs out</dt><dd>{provider.projectedRunOutAt
        ? <time dateTime={provider.projectedRunOutAt}>{runOutLabel(provider, now)}</time>
        : runOutLabel(provider, now)}</dd>
      <dt>Plan</dt><dd>{provider.plan ?? '—'}</dd>
      <dt>Refreshed</dt><dd>{ageLabel(provider.refreshedAt, now)}</dd>
      {provider.shortWindow && <><dt>{shortReadout(provider.shortWindow).split(' ')[0]}</dt><dd>{provider.shortWindow.remainingPercent == null ? '—' : `${provider.shortWindow.remainingPercent}%`}</dd></>}
    </dl>}
    {provider.error && !provider.notSetUp && <p>{provider.error}</p>}
  </span>
}

function Meter({ provider, now }: { provider: QuotaMeterProvider; now: number }) {
  const name = providerName(provider.id)
  const weekly = provider.weeklyWindow
  const remaining = weekly ? weekly.remainingPercent : provider.remainingPercent
  const label = provider.notSetUp ? `${name}, not signed in` : `${name}, ${remaining == null ? 'no reading' : `${remaining}% remaining`}`
  if (weekly || provider.notSetUp) {
    return <button type="button" className={`cockpit-quota-meter is-week is-${weekly?.level ?? provider.level}`} aria-label={label}>
      <span className="cockpit-quota-id"><Glyph id={provider.id} /><span>{name}</span></span>
      <WeeklyStrip window={weekly ?? { id: 'weekly', label: 'week', resetsAt: null, remainingPercent: null, level: 'error' }} now={now} />
      <span className="cockpit-quota-side">
        <span className="cockpit-quota-pct">{provider.notSetUp ? 'Sign in' : remaining == null ? '–' : remaining}</span>
        {provider.shortWindow && <span className="cockpit-quota-short">{shortReadout(provider.shortWindow)}</span>}
      </span>
      <Detail provider={provider} now={now} />
    </button>
  }
  const fill = remaining == null ? 0 : Math.max(0, Math.min(100, remaining))
  return <button type="button" className={`cockpit-quota-meter is-${provider.level}`} aria-label={label}>
    <Glyph id={provider.id} />
    <span className="cockpit-quota-bar" aria-hidden="true"><span style={{ width: `${fill}%` }} /></span>
    <span className="cockpit-quota-pct">{remaining == null ? '–' : remaining}</span>
    <Detail provider={provider} now={now} />
  </button>
}

export function QuotaMeters({ snapshot, now }: { snapshot: QuotaMeterSnapshot; now: number }) {
  const showRefresh = snapshot.commandError != null && snapshot.providers.length > 0
  const showOnlyError = snapshot.commandError != null && snapshot.providers.length === 0
  const weekly = snapshot.providers.filter(provider => provider.weeklyWindow || provider.notSetUp)
  const compact = snapshot.providers.filter(provider => !provider.weeklyWindow && !provider.notSetUp)
  return <section className="cockpit-quotas" aria-label="Provider quota">
    <div className="cockpit-quota-meters">
      {weekly.map(provider => <Meter key={provider.id} provider={provider} now={now} />)}
      {(compact.length > 0 || showRefresh || showOnlyError) && <div className="cockpit-quota-compact">
        {compact.map(provider => <Meter key={provider.id} provider={provider} now={now} />)}
        {(showRefresh || showOnlyError) && <button type="button" className="cockpit-quota-meter is-error" aria-label="Quota refresh, no reading">
        <svg className="cockpit-quota-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2 14.2 13H1.8Z" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d="M8 6.2v3.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="8" cy="11.2" r="0.7" fill="currentColor" /></svg>
        <span className="cockpit-quota-bar" aria-hidden="true"><span style={{ width: '0%' }} /></span>
        <span className="cockpit-quota-pct">–</span>
        <span className="cockpit-quota-popover" role="tooltip">
          <strong>Quota refresh</strong>
          <p>{snapshot.commandError}</p>
        </span>
      </button>}
      </div>}
    </div>
  </section>
}

export function QuotaRail() {
  const snapshot = useQuotaMeters()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  return <QuotaMeters snapshot={snapshot} now={now} />
}

/** Glyph and percent for the activity strip. Weekly strips stay on QuotaRail. */
const BADGE_LIMIT = 4

export function QuotaBadges() {
  const snapshot = useQuotaMeters()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])
  if (snapshot.providers.length === 0 || snapshot.providers.length > BADGE_LIMIT) return null
  return <div className="cockpit-quota-badges" aria-label="Quota summary">
    {snapshot.providers.map(provider => {
      const weekly = provider.weeklyWindow
      const remaining = weekly ? weekly.remainingPercent : provider.remainingPercent
      const name = providerName(provider.id)
      const level = weekly ? weekly.level : provider.level
      const label = provider.notSetUp ? `${name} summary, not signed in` : `${name} summary, ${remaining == null ? 'no reading' : `${remaining}% remaining`}`
      return <button type="button" key={provider.id} className={`cockpit-quota-badge is-${level}`} aria-label={label}>
        <Glyph id={provider.id} />
        <span className="cockpit-quota-pct">{remaining == null ? '–' : remaining}</span>
        <Detail provider={provider} now={now} />
      </button>
    })}
  </div>
}

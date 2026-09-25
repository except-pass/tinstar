import { useEffect, useState } from 'react'
import { apiFetch } from '../../apiClient'
import {
  formatPercentRemaining,
  freshnessLabel,
  parseAxiQuota,
  parseClaudeQuota,
  resetLabel,
  type AxiAccountView,
  type AxiScopeView,
  type AxiView,
  type ClaudeBucketView,
  type ClaudeView,
} from './parse'
import {
  CODEX_QUOTA_UNSUPPORTED_REASON,
  GROK_QUOTA_UNSUPPORTED_REASON,
} from './reasons'
import './quota.css'

const DEFAULT_POLL_MS = 60_000

export interface QuotaRailProps {
  /** Pins reset and freshness text. Skips the minute clock. */
  nowMs?: number
  /** Interval for both reads. 0 fetches once. */
  pollMs?: number
}

export function QuotaRail({ nowMs, pollMs = DEFAULT_POLL_MS }: QuotaRailProps) {
  const now = useMinuteClock(nowMs)
  const [claude, setClaude] = useState<ClaudeView>({ kind: 'loading' })
  const [axi, setAxi] = useState<AxiView>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    async function load() {
      const [nextClaude, nextAxi] = await Promise.all([readClaude(), readAxi()])
      if (cancelled) return
      setClaude(nextClaude)
      setAxi(nextAxi)
    }
    void load()
    if (!pollMs) return () => { cancelled = true }
    const timer = setInterval(() => { void load() }, pollMs)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [pollMs])

  return (
    <section className="v6-quota-rail" data-testid="v6-quota-rail" aria-label="Quota">
      <div className="v6-quota-head">
        <span className="v6-quota-title">Quota</span>
      </div>
      <p className="v6-quota-legend">Provider windows. Not worker context.</p>
      <ClaudeBlock view={claude} nowMs={now} />
      <UnsupportedBlock
        testId="v6-quota-codex"
        name="Codex"
        reason={CODEX_QUOTA_UNSUPPORTED_REASON}
      />
      <UnsupportedBlock
        testId="v6-quota-grok"
        name="Grok"
        reason={GROK_QUOTA_UNSUPPORTED_REASON}
      />
      <AxiBlock view={axi} nowMs={now} />
    </section>
  )
}

function ClaudeBlock({ view, nowMs }: { view: ClaudeView; nowMs: number }) {
  return (
    <section className="v6-quota-provider" data-testid="v6-quota-claude" aria-label="Claude">
      <div className="v6-quota-name">Claude</div>
      {view.kind === 'unavailable' && <State text="unavailable" />}
      {view.kind === 'not-configured' && (
        <>
          {view.fixture && <FixtureMark />}
          <State text="not configured" />
        </>
      )}
      {view.kind === 'ready' && (
        <>
          {view.fixture && <FixtureMark />}
          <div className="v6-quota-meta" data-testid="v6-quota-claude-freshness">
            {freshnessLabel(view.fetchedAt, nowMs)}
          </div>
          <BucketRow testId="v6-quota-claude-5h" label="5h window" bucket={view.fiveHour} nowMs={nowMs} />
          <BucketRow testId="v6-quota-claude-7d" label="7d window" bucket={view.sevenDay} nowMs={nowMs} />
          {view.error && <State text={view.error} />}
        </>
      )}
    </section>
  )
}

function BucketRow({
  testId,
  label,
  bucket,
  nowMs,
}: {
  testId: string
  label: string
  bucket: ClaudeBucketView
  nowMs: number
}) {
  if (bucket.kind !== 'ready') {
    return (
      <div className="v6-quota-row" data-testid={testId}>
        <div className="v6-quota-meta">{label}</div>
        <State text={bucket.kind === 'not-configured' ? 'not configured' : 'unavailable'} />
      </div>
    )
  }
  return (
    <div className="v6-quota-row" data-testid={testId}>
      <div className="v6-quota-big">{bucket.remaining}% left</div>
      <div className="v6-quota-meta">
        {label} · usage window · {resetLabel(bucket.resetsAt, nowMs)}
      </div>
      <Meter
        remaining={bucket.remaining}
        label={`${label}: ${bucket.remaining}% left of the usage window`}
      />
    </div>
  )
}

function UnsupportedBlock({
  testId,
  name,
  reason,
}: {
  testId: string
  name: string
  reason: string
}) {
  return (
    <section className="v6-quota-provider" data-testid={testId} aria-label={name}>
      <div className="v6-quota-name">{name}</div>
      <State text="Unsupported" />
      <div className="v6-quota-meta">{reason}</div>
    </section>
  )
}

function AxiBlock({ view, nowMs }: { view: AxiView; nowMs: number }) {
  return (
    <section className="v6-quota-provider" data-testid="v6-quota-axi" aria-label="quota-axi">
      <div className="v6-quota-name">quota-axi</div>
      {view.kind === 'unavailable' && (
        <>
          {view.fixture && <FixtureMark />}
          <State text="unavailable" />
        </>
      )}
      {view.kind === 'ready' && (
        <>
          {view.fixture && <FixtureMark />}
          <div className="v6-quota-meta" data-testid="v6-quota-axi-freshness">
            schema {view.schemaVersion}
            {' · '}
            {view.generatedAt ? freshnessLabel(view.generatedAt, nowMs) : 'freshness unknown'}
          </div>
          {view.accounts.length === 0 && <State text="no accounts" />}
          {view.accounts.map((account) => (
            <AxiAccount key={accountKeyOf(account)} account={account} nowMs={nowMs} />
          ))}
        </>
      )}
    </section>
  )
}

function AxiAccount({ account, nowMs }: { account: AxiAccountView; nowMs: number }) {
  const accountLabel = account.accountKey ?? 'no account key'
  return (
    <div
      data-testid={`v6-quota-axi-${account.provider}-${account.accountKey ?? 'schema5'}`}
    >
      <div className="v6-quota-account">
        {account.provider} · {accountLabel} · {account.freshness}
      </div>
      {account.scopes.length === 0 && <State text={account.semantics} />}
      {account.scopes.map((scope, index) => (
        <AxiScopeRow key={`${scope.scope}:${index}`} scope={scope} nowMs={nowMs} />
      ))}
    </div>
  )
}

function AxiScopeRow({ scope, nowMs }: { scope: AxiScopeView; nowMs: number }) {
  const measured = scope.status === 'known'
    && scope.unit === 'percent-remaining'
    && typeof scope.percentRemaining === 'number'
  if (!measured || scope.percentRemaining === null) {
    return (
      <div className="v6-quota-row" data-testid={`v6-quota-axi-scope-${scope.scope}`}>
        <div className="v6-quota-meta">{scope.scope}</div>
        <State text="unknown" />
      </div>
    )
  }
  const remaining = scope.percentRemaining
  return (
    <div className="v6-quota-row" data-testid={`v6-quota-axi-scope-${scope.scope}`}>
      <div className="v6-quota-big">{formatPercentRemaining(remaining)}</div>
      <div className="v6-quota-meta">
        {scope.scope}
        {' · percent remaining'}
        {scope.runway ? ` · runway ${scope.runway}` : ''}
        {scope.resetsAt ? ` · ${resetLabel(scope.resetsAt, nowMs)}` : ''}
      </div>
      <Meter
        remaining={remaining}
        label={`${scope.scope}: ${formatPercentRemaining(remaining)}`}
      />
    </div>
  )
}

function Meter({ remaining, label }: { remaining: number; label: string }) {
  const width = Math.max(0, Math.min(100, remaining))
  return (
    <div
      className="v6-quota-meter"
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={width}
      aria-label={label}
    >
      <span style={{ width: `${width}%` }} />
    </div>
  )
}

function State({ text }: { text: string }) {
  return <div className="v6-quota-state">{text}</div>
}

function FixtureMark() {
  return <span className="v6-quota-fixture" data-testid="v6-quota-fixture">fixture</span>
}

function accountKeyOf(account: AxiAccountView): string {
  return `${account.provider}:${account.accountKey ?? ''}`
}

function useMinuteClock(nowMs: number | undefined): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (nowMs !== undefined) return
    const timer = setInterval(() => setTick((value) => value + 1), 60_000)
    return () => clearInterval(timer)
  }, [nowMs])
  void tick
  return nowMs ?? Date.now()
}

async function readClaude(): Promise<ClaudeView> {
  try {
    const res = await apiFetch('/api/cc-quota')
    if (!res.ok) return { kind: 'unavailable' }
    return parseClaudeQuota(await res.json())
  } catch {
    return { kind: 'unavailable' }
  }
}

async function readAxi(): Promise<AxiView> {
  try {
    const res = await apiFetch('/api/v6/quota')
    if (!res.ok) return { kind: 'unavailable', fixture: false }
    return parseAxiQuota(await res.json())
  } catch {
    return { kind: 'unavailable', fixture: false }
  }
}

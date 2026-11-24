import { useState } from 'react'
import { apiFetch } from '../apiClient'
import type { OwnerMergeAsk, OwnerReadyRead, OwnerRequestSource } from '../shared/ownerReady'
import { displayRequestText } from './requestText'

const mergeLabel = (merge: OwnerMergeAsk) => {
  if (merge.live?.state === 'stale') return 'Requested head changed'
  if (!merge.requestedHeads.length) return 'Requested head unverified'
  if (merge.live?.state === 'ready') return 'Ready at requested head'
  if (merge.live?.state === 'pending') return 'Waiting for PR readiness'
  return 'Needs verification'
}

function Sources({ sources }: { sources: Array<OwnerRequestSource & { requestedHead?: string | null; superseded?: true }> }) {
  return <ul className="owner-ready-sources">{sources.map(source =>
    <li key={`${source.kind}:${source.id}`}>{source.url
      ? <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>
      : source.label}{source.requestedHead && <> · Requested <code>{source.requestedHead}</code></>}{source.superseded && ' · Superseded'}</li>)}</ul>
}

export function OwnerReady({ read }: { read: OwnerReadyRead }) {
  const [lastCheck, setLastCheck] = useState<OwnerReadyRead>()
  const [checking, setChecking] = useState(false)
  const [failed, setFailed] = useState(false)
  const current = lastCheck && lastCheck.observedAt >= read.observedAt ? lastCheck : read

  async function recheck() {
    setChecking(true)
    setFailed(false)
    try {
      const response = await apiFetch('/api/reconciliation/owner-ready?recheck=1', {
        headers: { 'X-Tinstar-UI': '1' }, signal: AbortSignal.timeout(60_000),
      })
      const body = await response.json()
      if (!response.ok || !body.ok || !Array.isArray(body.data?.repositories)) throw new Error('recheck unavailable')
      setLastCheck(body.data)
    } catch { setFailed(true) }
    finally { setChecking(false) }
  }

  return <details className="owner-ready">
    <summary>Owner-ready by repository</summary>
    <button type="button" onClick={() => void recheck()} disabled={checking}>{checking ? 'Rechecking current requests…' : 'Recheck current requests'}</button>
    {failed && <p role="status">Recheck unavailable. Treat displayed PR evidence as last-known.</p>}
    {lastCheck?.recheckedAt && !failed && !checking && <p role="status">Last recheck <time dateTime={lastCheck.recheckedAt}>{new Date(lastCheck.recheckedAt).toLocaleString()}</time></p>}
    {!!current.warnings.length && <details><summary>Source coverage</summary><ul>{current.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
    {!current.repositories.length && <p>No owner requests in the available records.</p>}
    {current.repositories.map(group => <section key={group.repository ?? ''}>
      <h3>{group.repository ?? 'Repository unspecified'}</h3>
      <ul>{group.merges.map(merge => <li key={merge.url ?? merge.sources[0]?.id}>
        {merge.url ? <a href={merge.url} target="_blank" rel="noreferrer">{merge.url}</a> : 'Merge request · PR URL unverified'}
        <div>{mergeLabel(merge)}</div>
        {merge.live?.head && <div>Live <code>{merge.live.head}</code></div>}
        <Sources sources={merge.sources} />
      </li>)}
      {group.decisions.map(decision => <li key={decision.id}>{displayRequestText(decision.question)}
        {!decision.fresh && <div>Needs verification</div>}
        <Sources sources={decision.sources} />
      </li>)}</ul>
    </section>)}
  </details>
}

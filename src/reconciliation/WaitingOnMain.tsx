import { useState } from 'react'
import { nudgeUnanswered, waitAgeLabel, type MainWaitRead } from '../shared/waitingOnMain'
import './waitingOnMain.css'

export function WaitingOnMain({ data, now, readFailed = false }: { data?: MainWaitRead; now: number; readFailed?: boolean }) {
  const [open, setOpen] = useState(false)
  const items = data?.items ?? []
  const unanswered = items.some(item => nudgeUnanswered(item.nudgedAt, now))
  if (!unanswered) return null
  const unknown = readFailed || !data || !!data.error || data.unknown.length > 0 || items.some(item => !item.fresh)
  return <section className="ov-main-waits-quiet" aria-label="Waiting on First Mate" data-overdue="false">
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>First Mate nudge still open</button>
    {open && <div className="ov-main-waits-list">
      {unknown && <p role="status">{data?.error ?? 'Some sources are unknown or stale; this count may be incomplete.'} {data?.unknown.join(' · ')}</p>}
      {items.map(item => <article key={item.id} className={item.alert === 'plain-comment' ? 'ov-main-wait-undelivered' : undefined}>
        <strong>{item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.label} ↗</a> : item.label}</strong>
        <code>{item.key}</code><span>{item.ageBasis === 'at least' ? 'At least ' : ''}{waitAgeLabel(item.since, now)}{!item.fresh || readFailed ? ' · last known' : ''}</span>
        <p>{item.text}</p>
        {item.alert === 'plain-comment' && <p role="status">Owner alert not delivered (mention failed) · plain Notion comment posted; next attempt after the 4h throttle.</p>}
        {item.alert === 'mentioned' && <small>Owner mentioned in Notion</small>}
        {item.alert === 'unconfirmed' && <p role="status">Notion alert delivery unconfirmed · next attempt after the 4h throttle.</p>}
        {item.alert === 'failed' && <p role="status">Notion alert failed · next attempt after the 4h throttle.</p>}
        {item.alert === 'disabled' && <small>Notion alerts disabled for this instance</small>}
      </article>)}
      {!items.length && !unknown && <p>No waits on First Mate.</p>}
    </div>}
  </section>
}

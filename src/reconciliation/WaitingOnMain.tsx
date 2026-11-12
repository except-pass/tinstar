import { useState } from 'react'
import { MAIN_WAIT_INTERVAL, waitAge, waitAgeLabel, type MainWaitRead } from '../shared/waitingOnMain'

export function WaitingOnMain({ data, now, readFailed = false }: { data?: MainWaitRead; now: number; readFailed?: boolean }) {
  const [open, setOpen] = useState(false)
  const items = data?.items ?? []
  const ages = items.flatMap(item => { const age = waitAge(item.since, now); return age === null ? [] : [age] })
  const oldest = items.filter(item => waitAge(item.since, now) !== null).sort((a, b) => Date.parse(a.since!) - Date.parse(b.since!))[0]
  const overdue = ages.some(age => age >= MAIN_WAIT_INTERVAL)
  const unknown = readFailed || !data || !!data.error || data.unknown.length > 0 || items.some(item => !item.fresh)
  return <section className={`ov-main-waits${overdue ? ' ov-main-waits-overdue' : ''}`} aria-label="Waiting on First Mate" data-overdue={overdue}>
    <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <strong>Waiting on First Mate · {items.length || !unknown ? items.length : 'unknown'}{unknown && items.length > 0 ? '+' : ''}</strong>
      <span> · {oldest ? `oldest ${oldest.ageBasis === 'at least' ? 'at least ' : ''}${waitAgeLabel(oldest.since, now)}` : items.length ? 'age unknown' : 'no known waits'}{unknown ? ' · coverage unknown' : ''}</span>
    </button>
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

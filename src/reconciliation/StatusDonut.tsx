import { compareStatus } from '../shared/floorStatus'

export interface StatusCount { status: string; count: number }
// A stable source-label color; labels and pressed states carry the meaning too.
export function statusColor(status: string) {
  let hash = 0
  for (const char of status) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return `hsl(${(hash >>> 0) % 360} 48% 66%)`
}
export function StatusDonut({ domain, counts, selected, visible, open, onOpen, onToggle, countNote }: {
  domain: 'cards' | 'workers'; counts: StatusCount[]; selected: string[]; visible: number
  countNote?: string; open: boolean; onOpen: () => void; onToggle: (status: string) => void
}) {
  const label = domain === 'cards' ? 'Cards' : 'Workers'
  const options = [...counts, ...selected.filter(status => !counts.some(c => c.status === status)).map(status => ({ status, count: 0 }))].sort((a, b) => compareStatus(a.status, b.status, domain))
  const total = counts.reduce((sum, c) => sum + c.count, 0)
  let offset = 0
  return <div className="ov-donut-control">
    <svg className="ov-donut" viewBox="0 0 40 40" role="group" aria-label={`${label} status distribution`}>
      <circle cx="20" cy="20" r="15.5" fill="none" stroke="#263b45" strokeWidth="7" />
      {options.filter(c => c.count > 0).map(({ status, count }) => {
        const fraction = count / total, start = offset
        offset += fraction
        const angle = (value: number) => value * 2 * Math.PI - Math.PI / 2
        const x = (value: number) => 20 + 15.5 * Math.cos(angle(value)), y = (value: number) => 20 + 15.5 * Math.sin(angle(value))
        // Two arcs also represent a full ring correctly when one status remains.
        const mid = start + fraction / 2, end = start + fraction
        const path = `M${x(start)},${y(start)} A15.5,15.5 0 0 1 ${x(mid)},${y(mid)} A15.5,15.5 0 0 1 ${x(end)},${y(end)}`
        return <path key={status} d={path} fill="none" stroke={statusColor(status)} strokeWidth={selected.includes(status) ? 10 : 7} className={selected.length && !selected.includes(status) ? 'ov-slice-unselected' : ''} role="button" tabIndex={0} aria-label={`${label}: ${status}, ${count}`} aria-pressed={selected.includes(status)} onClick={() => onToggle(status)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(status) } }}><title>{status}: {count}{selected.includes(status) ? ' · Selected' : ''}</title></path>
      })}
    </svg>
    <button type="button" className="ov-donut-trigger" title={countNote} aria-label={`${label} statuses: ${countNote === 'unknown' || countNote === 'unavailable' ? countNote : `${visible} visible, ${total} eligible${countNote ? ` · ${countNote}` : ''}`}`} aria-expanded={open} aria-controls={`ov-${domain}-statuses`} onClick={onOpen}><span>{label}{countNote && <span className="ov-count-note" aria-hidden="true"> · {countNote === 'partial' ? 'partial' : countNote === 'last known' ? 'last known' : '?'}</span>}</span><b>{countNote === 'unknown' || countNote === 'unavailable' ? '?' : `${visible}/${total}`}</b></button>
    <span className="ov-donut-key" aria-hidden="true">{options.filter(c => c.count).slice(0, 2).map(c => <span key={c.status}><i style={{ background: statusColor(c.status) }} />{c.status} {c.count}</span>)}</span>
    {open && <section className="ov-popover ov-donut-options" id={`ov-${domain}-statuses`} aria-label={`${label} statuses`}>
      <header><strong>{label} · {countNote === 'unknown' || countNote === 'unavailable' ? countNote : `${visible} visible / ${total} eligible${countNote ? ` · ${countNote}` : ''}`}</strong><button type="button" aria-label={`Close ${domain} statuses`} onClick={onOpen}>×</button></header>
      {options.length ? options.map(({ status, count }) => <button type="button" key={status} aria-pressed={selected.includes(status)} onClick={() => onToggle(status)}><i style={{ background: statusColor(status) }} /><span>{status}</span><b>{count}</b>{selected.includes(status) && <span aria-hidden="true">✓</span>}</button>) : <p>No eligible {domain}</p>}
    </section>}
  </div>
}

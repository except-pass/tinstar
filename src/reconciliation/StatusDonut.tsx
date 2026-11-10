import type { CSSProperties } from 'react'
import { compareStatus } from '../shared/floorStatus'

export interface StatusCount { status: string; count: number }
// A stable source-label color; labels and pressed states carry the meaning too.
export function statusColor(status: string) {
  let hash = 0
  for (const char of status) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return `hsl(${(hash >>> 0) % 360} 48% 66%)`
}
export function StatusDonut({ domain, counts, selected, visible, onClear, onToggle, countNote }: {
  domain: 'cards' | 'workers'; counts: StatusCount[]; selected: string[]; visible: number
  countNote?: string; onClear: () => void; onToggle: (status: string) => void
}) {
  const label = domain === 'cards' ? 'Cards' : 'Workers'
  const options = [...counts, ...selected.filter(status => !counts.some(c => c.status === status)).map(status => ({ status, count: 0 }))].sort((a, b) => compareStatus(a.status, b.status, domain))
  const total = counts.reduce((sum, c) => sum + c.count, 0)
  let offset = 0
  const unavailable = countNote === 'unknown' || countNote === 'unavailable'
  return <section className="ov-legend-group" aria-label={`${label} statuses`}>
    <div className="ov-legend-heading">
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
    <div className="ov-legend-label" title={countNote}><strong>{label}</strong><small>{unavailable ? countNote : `${visible} / ${total}${countNote ? ` · ${countNote}` : ''}`}</small></div>
    </div>
    <div className="ov-status-list" role="group" aria-label={`Filter by ${domain === 'cards' ? 'card' : 'worker'} status`}>
      <button type="button" className="ov-status-chip ov-status-all" aria-label={`All ${domain} statuses`} aria-pressed={!selected.length} onClick={onClear}>{!selected.length && <span aria-hidden="true">✓</span>}All</button>
      {options.map(({ status, count }) => <button type="button" key={status} className={`ov-status-chip${selected.length && !selected.includes(status) ? ' ov-status-muted' : ''}`} style={{ '--status-color': statusColor(status) } as CSSProperties} aria-label={`Filter ${label}: ${status}, ${unavailable ? countNote : count}`} aria-pressed={selected.includes(status)} title={`${status}: ${unavailable ? countNote : `${count} (${total ? Math.round(count / total * 100) : 0}%)`}`} onClick={() => onToggle(status)}><i aria-hidden="true" /><span>{status}</span><b>{unavailable ? '—' : count}</b>{selected.includes(status) && <span aria-hidden="true">✓</span>}</button>)}
      {!options.length && <span className="ov-no-filters">{unavailable ? `${label} ${countNote}` : `No eligible ${domain}`}</span>}
    </div>
  </section>
}

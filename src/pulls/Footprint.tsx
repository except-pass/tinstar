import { askElement } from '../ask/element'
import { useState } from 'react'
import { footprintTotals, type FootprintCategory, type PullFootprint } from '../shared/pullFootprint'

export function Footprint({ data }: { data: PullFootprint }) {
  const [excludeGenerated, setExcludeGenerated] = useState(false), [category, setCategory] = useState<FootprintCategory | null>(null)
  const totals = footprintTotals(data.files, excludeGenerated)
  const files = data.files.filter(file => (!category || file.category === category) && (!excludeGenerated || file.category !== 'Generated & Dependencies'))
    .sort((a, b) => b.additions + b.deletions - a.additions - a.deletions || a.filename.localeCompare(b.filename))
  return <section className="pr-footprint" aria-label="Change footprint">
    <h2 {...askElement('changes', 'Change footprint')}>Change footprint · {data.files.length} / {data.expectedFiles} files · {data.complete ? 'Complete' : 'Partial'}{data.freshness === 'stale' && ' · stale'}</h2>
    {data.error && <p role="status">{data.error}</p>}
    <label><input type="checkbox" checked={excludeGenerated} onChange={event => { setExcludeGenerated(event.target.checked); setCategory(null) }} /> Exclude generated &amp; dependencies</label>
    <p {...askElement('changes', 'Changed lines')}>{totals.total.toLocaleString()} observed changed lines · Handwritten Code: {totals.handwrittenCode.toLocaleString()} lines (generated/dependencies excluded). Percentages use additions + deletions{!data.complete && ' in observed files only'}.</p>
    <div className="pr-footprint-bar" aria-hidden="true">{totals.categories.map((item, index) => <span key={item.category} className={`pr-category-${index}`} style={{ width: `${item.percent}%` }} />)}</div>
    <div className="pr-footprint-categories"><button {...askElement('changes', 'File category')} type="button" aria-pressed={category === null} onClick={() => setCategory(null)}>All files</button>{totals.categories.map(item => <button {...askElement('changes', 'File category')} type="button" key={item.category} aria-pressed={category === item.category} onClick={() => setCategory(item.category)}>{item.category}: {item.percent.toFixed(1)}% · {item.lines.toLocaleString()} lines · {item.files} files</button>)}</div>
    <ul className="pr-file-list">{files.map(file => <li key={file.filename}><a {...askElement('changes', 'Filename')} href={file.url} target="_blank" rel="noreferrer">{file.filename}</a> · <span {...askElement('status', 'File status')}>{file.status}</span> · <span {...askElement('changes', 'File changes')}>+{file.additions} / −{file.deletions}{!file.additions && !file.deletions && ' · 0 line changes (binary or metadata-only)'}</span>{file.previousFilename && <span {...askElement('changes', 'Previous filename')}> · renamed from {file.previousFilename}</span>}</li>)}</ul>
    {!files.length && <p>No observed files in this category.</p>}
    <small {...askElement('last_edited', 'Footprint observation')}>Observed {data.observedAt} · GitHub head {data.head.slice(0, 12)} · base {data.baseHead.slice(0, 12)}</small>
  </section>
}

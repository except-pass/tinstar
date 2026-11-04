import { useState } from 'react'
import { currentStatusOptions, defaultOrganizer, defaultStatusFilter, floorFields, operationalStatuses, type FloorField, type Organizer } from '../shared/floorOrganization'
import type { FloorScene, PresentationAction, PresentationState, Target } from './presentation'

export function FloorToolbar({ scene, state, send, gaps }: { scene: FloorScene; state: PresentationState; send: (action: PresentationAction) => void; gaps: Target[] }) {
  const [panel, setPanel] = useState<'filters' | 'fields' | null>(null), [chosen, setChosen] = useState<FloorField | null>(null)
  const organizer = state.organizer ?? defaultOrganizer(), filter = state.statusFilter ?? defaultStatusFilter()
  const options = currentStatusOptions(scene)
  const selected = filter.preset === 'all' ? options : filter.preset === 'operational' ? options.filter(s => operationalStatuses.includes(s)) : filter.statuses
  const place = (slot: 'outer' | 'inner' | 'order', value: string) => {
    if (value !== 'none' && !floorFields.some(f => f.id === value) || slot === 'order' && value === 'none') return
    send({ type: 'set-organizer', organizer: { ...organizer, [slot]: value } as Organizer })
  }
  return <div className="ov-organizer" onKeyDown={e => { if (e.key === 'Escape') { setPanel(null); setChosen(null); e.stopPropagation() } }}>
    <div className="ov-toolbar" aria-label="Arrange work">
      {(['outer', 'inner', 'order'] as const).map(slot => <label key={slot} className="ov-slot" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); place(slot, e.dataTransfer.getData('text/plain')) }}>
        <span>{slot}</span><select aria-label={slot === 'order' ? 'Order by' : `${slot === 'outer' ? 'Outer' : 'Inner'} grouping`} value={organizer[slot]} onChange={e => place(slot, e.target.value)}>
          {slot !== 'order' && <option value="none">None</option>}
          {(['worker', 'task'] as const).map(source => <optgroup key={source} label={source === 'worker' ? 'Worker' : 'Work'}>{floorFields.filter(f => f.source === source).map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</optgroup>)}
        </select>
      </label>)}
      <button type="button" aria-label="Reverse sort direction" title={organizer.direction === 'asc' ? 'Ascending' : 'Descending'} onClick={() => send({ type: 'set-organizer', organizer: { ...organizer, direction: organizer.direction === 'asc' ? 'desc' : 'asc' } })}>{organizer.direction === 'asc' ? '↑' : '↓'}</button>
      <select className="ov-preset" aria-label="Status preset" value={filter.preset} onChange={e => send({ type: 'set-status-filter', filter: { preset: e.target.value as typeof filter.preset, statuses: e.target.value === 'custom' ? selected : filter.statuses } })}>
        <option value="operational">Operational</option><option value="all">All cards</option><option value="custom">Custom</option>
      </select>
      <button type="button" aria-expanded={panel === 'filters'} aria-controls="floor-filters" onClick={() => setPanel(panel === 'filters' ? null : 'filters')}>Filters</button>
      <button type="button" aria-expanded={panel === 'fields'} aria-controls="floor-fields" onClick={() => setPanel(panel === 'fields' ? null : 'fields')}>Fields</button>
      <button type="button" onClick={() => { send({ type: 'reset-floor' }); setPanel(null); setChosen(null) }}>Reset</button>
    </div>
    {panel === 'filters' && <section className="ov-popover" id="floor-filters" aria-label="Filters"><header><strong>Task Status</strong><button type="button" aria-label="Close filters" onClick={() => setPanel(null)}>×</button></header>
      <div className="ov-status-options">{options.map(status => <label key={status}><input type="checkbox" checked={selected.includes(status)} onChange={e => send({ type: 'set-status-filter', filter: { preset: 'custom', statuses: e.target.checked ? [...selected, status] : selected.filter(s => s !== status) } })} />{status}</label>)}</div>
      {!options.length && <p>Status options unavailable</p>}
      <div className="ov-filters"><button type="button" aria-pressed={state.exceptionsOnly} onClick={() => send({ type: 'set-exceptions', enabled: !state.exceptionsOnly })}>◇ Gaps only</button><button type="button" disabled={!gaps.length} onClick={() => send({ type: 'flash', targets: gaps })}>✧ Find gaps</button><button type="button" aria-pressed={state.linksVisible !== false} onClick={() => send({ type: 'set-links', visible: state.linksVisible === false })}>Links</button></div>
    </section>}
    {panel === 'fields' && <section className="ov-field-palette" id="floor-fields" aria-label="Fields">
      {floorFields.map(f => <button key={f.id} type="button" draggable onDragStart={e => { e.dataTransfer.setData('text/plain', f.id); e.dataTransfer.effectAllowed = 'copy' }} aria-pressed={chosen === f.id} onClick={() => setChosen(f.id)}><small>{f.source === 'worker' ? 'Worker' : 'Work'}</small> {f.label} <span aria-hidden="true">⠿</span></button>)}
      {chosen && <div className="ov-placement" role="group" aria-label={`Place ${floorFields.find(f => f.id === chosen)!.label}`}><span>{floorFields.find(f => f.id === chosen)!.label} →</span>{(['outer', 'inner', 'order'] as const).map(slot => <button key={slot} type="button" onClick={() => place(slot, chosen)}>{slot}</button>)}</div>}
    </section>}
  </div>
}

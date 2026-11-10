import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cardStatusName, currentStatusOptions, defaultOrganizer, organizerPresets, organizerPreset, statusProjection, defaultStatusFilter, floorFields, operationalStatuses, type FloorField, type Organizer } from '../shared/floorOrganization'
import { floorWorkerStatus, hasDonutFilter } from '../shared/floorStatus'
import { FloorRefresh, type FloorSync } from './FloorRefresh'
import { PatternDial } from './PatternDial'
import type { PatternCoverage } from './overviewEvidence'
import { StatusDonut, type StatusCount } from './StatusDonut'
import type { OverviewDensity } from './overviewDensity'
import type { FloorScene, PresentationAction, PresentationState, Target } from './presentation'

export function FloorToolbar({ scene, state, send, gaps, density, onDensityChange, now = Date.now(), visibleWorkers, visibleCards, sourceLabel, onSourceDetails, countNotes, searchControl, sync, patternCoverage, onInspectPatternCoverage }: { scene: FloorScene; state: PresentationState; send: (action: PresentationAction) => void; gaps: Target[]; density?: OverviewDensity; onDensityChange?: (density: OverviewDensity) => void; countNotes?: { cards?: string; workers?: string }; now?: number; visibleWorkers?: number; visibleCards?: number; sourceLabel?: string; onSourceDetails?: () => void; searchControl?: ReactNode; sync?: FloorSync; patternCoverage?: PatternCoverage | null; onInspectPatternCoverage?: () => void }) {
  const [panel, setPanel] = useState<'customize' | 'cards' | 'workers' | null>(null)
  const [advanced, setAdvanced] = useState<'filters' | 'fields' | null>(null), [chosen, setChosen] = useState<FloorField | null>(null)
  const organizer = state.organizer ?? defaultOrganizer(), filter = state.statusFilter ?? defaultStatusFilter()
  const host = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement | null>(null)
  const close = () => { setPanel(null); trigger.current?.focus() }
  useEffect(() => {
    if (!panel) return
    const outside = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) setPanel(null) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [panel])
  const projection = statusProjection(scene, state, now), selection = state.donutFilter ?? { cards: [], workers: [] }
  const distribution = (statuses: string[]): StatusCount[] => [...statuses.reduce((counts, status) => counts.set(status, (counts.get(status) ?? 0) + 1), new Map<string, number>())].map(([status, count]) => ({ status, count }))
  const toggle = (domain: 'cards' | 'workers', status: string) => send({ type: 'set-donut-filter', filter: { ...selection, [domain]: selection[domain].includes(status) ? selection[domain].filter(value => value !== status) : [...selection[domain], status] } })
  const options = currentStatusOptions(scene)
  const selected = filter.preset === 'all' ? options : filter.preset === 'operational' ? options.filter(s => operationalStatuses.includes(s)) : filter.statuses
  const place = (slot: 'outer' | 'inner' | 'order', value: string) => {
    if (slot === 'order' && value === 'operational') {
      send({ type: 'set-organizer', organizer: { ...organizer, order: 'operational' } })
      return
    }
    if (value !== 'none' && !floorFields.some(f => f.id === value) || slot === 'order' && value === 'none') return
    send({ type: 'set-organizer', organizer: { ...organizer, [slot]: value } as Organizer })
  }
  return <div ref={host} className="ov-organizer" onKeyDown={e => { if (e.key === 'Escape' && panel) { close(); setChosen(null); e.stopPropagation() } }}>
    <div className="ov-toolbar" role="toolbar" aria-label="Arrange work">
      <div className="ov-preset-scroll" role="group" aria-label="Organizer presets">{(Object.keys(organizerPresets) as Array<keyof typeof organizerPresets>).map(preset => <button type="button" key={preset} aria-pressed={organizerPreset(organizer) === preset} onClick={() => send({ type: 'set-organizer', organizer: { ...organizerPresets[preset] } })}>By {preset === 'initiative' ? 'Initiative' : preset === 'machine' ? 'Machine' : 'Manager'}</button>)}</div>
      <button type="button" className="ov-customize-trigger" aria-label="Customize" aria-expanded={panel === 'customize'} aria-controls="floor-customize" onClick={event => { trigger.current = event.currentTarget; setPanel(panel === 'customize' ? null : 'customize') }}>⚙<span> Customize{!organizerPreset(organizer) ? ' •' : ''}</span></button>
      {searchControl}
      {sync && <FloorRefresh sync={sync} scene={scene} now={now} />}
      <PatternDial coverage={patternCoverage} onInspectCoverage={onInspectPatternCoverage} scene={scene} state={state} send={send} now={now} />
      <div className="ov-filter-chips" aria-label="Selected statuses">{(['workers', 'cards'] as const).flatMap(domain => selection[domain].map(status => <button type="button" key={`${domain}:${status}`} title={`Remove ${domain}: ${status}`} aria-label={`Remove ${domain}: ${status}`} onClick={() => toggle(domain, status)}>{domain === 'cards' ? '▤' : '◇'} {status} ×</button>))}</div>
      <div className="ov-donuts">{(['workers', 'cards'] as const).map(domain => <StatusDonut key={domain} domain={domain} countNote={countNotes?.[domain]} counts={distribution(domain === 'cards' ? projection.cardCandidates.map(cardStatusName) : projection.workerCandidates.map(worker => floorWorkerStatus(worker, now)))} selected={selection[domain]} visible={domain === 'cards' ? visibleCards ?? projection.cards.length : visibleWorkers ?? projection.workers.length} open={panel === domain} onOpen={() => { trigger.current = host.current?.querySelector<HTMLButtonElement>(`.ov-donut-trigger[aria-controls="ov-${domain}-statuses"]`) ?? null; if (panel === domain) close(); else setPanel(domain) }} onToggle={status => toggle(domain, status)} />)}</div>
      <button type="button" className="ov-clear-filters" aria-label="Clear all status selections" title="Clear all status selections" disabled={!hasDonutFilter(selection)} onClick={() => send({ type: 'clear-donut-filter' })}>×<span> Clear</span></button>
      {onSourceDetails && <button type="button" className={`ov-source-indicator ${sourceLabel === 'Sources connected' ? 'ov-signal' : 'ov-warning'}`} title={sourceLabel} aria-label={`${sourceLabel} · Details`} onClick={onSourceDetails}>◉</button>}
    </div>
    {panel === 'customize' && <section className="ov-popover ov-customize" id="floor-customize" aria-label="Customize view">
    <header><strong>Customize{organizerPreset(organizer) ? '' : ' · Custom'}</strong><button type="button" aria-label="Close Customize" onClick={close}>×</button></header>
    <div className="ov-advanced-controls">

      {(['outer', 'inner', 'order'] as const).map(slot => <label key={slot} className="ov-slot" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); place(slot, e.dataTransfer.getData('text/plain')) }}>
        <span>{slot}</span><select aria-label={slot === 'order' ? 'Order by' : `${slot === 'outer' ? 'Outer' : 'Inner'} grouping`} value={organizer[slot]} onChange={e => place(slot, e.target.value)}>
          {slot === 'order' ? <option value="operational">Operational status</option> : <option value="none">None</option>}
          {(['worker', 'task'] as const).map(source => <optgroup key={source} label={source === 'worker' ? 'Worker' : 'Work'}>{floorFields.filter(f => f.source === source).map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</optgroup>)}
        </select>
      </label>)}
      {onDensityChange && <div className="ov-segments ov-density-control" role="group" aria-label="Overview density">{(['compact', 'detailed'] as const).map(value => <button type="button" key={value} aria-pressed={density === value} onClick={() => onDensityChange(value)}>{value === 'compact' ? 'Ultra Compact' : 'Detailed'}</button>)}</div>}
      <button type="button" aria-label="Reverse sort direction" title={organizer.direction === 'asc' ? 'Ascending' : 'Descending'} onClick={() => send({ type: 'set-organizer', organizer: { ...organizer, direction: organizer.direction === 'asc' ? 'desc' : 'asc' } })}>{organizer.direction === 'asc' ? '↑' : '↓'}</button>
      <select className="ov-preset" aria-label="Status preset" value={filter.preset} onChange={e => send({ type: 'set-status-filter', filter: { preset: e.target.value as typeof filter.preset, statuses: e.target.value === 'custom' ? selected : filter.statuses } })}>
        <option value="operational">Operational</option><option value="all">All cards</option><option value="custom">Custom</option>
      </select>
      <button type="button" aria-expanded={advanced === 'filters'} aria-controls="floor-filters" onClick={() => setAdvanced(advanced === 'filters' ? null : 'filters')}>Filters</button>
      <button type="button" aria-expanded={advanced === 'fields'} aria-controls="floor-fields" onClick={() => setAdvanced(advanced === 'fields' ? null : 'fields')}>Fields</button>
      <button type="button" onClick={() => { send({ type: 'reset-floor' }); setAdvanced(null); setChosen(null) }}>Reset</button>
    </div>
    {advanced === 'filters' && <section className="ov-advanced-filters" id="floor-filters" aria-label="Filters"><header><strong>Task Status</strong><button type="button" aria-label="Close filters" onClick={() => setAdvanced(null)}>×</button></header>
      <div className="ov-status-options">{options.map(status => <label key={status}><input type="checkbox" checked={selected.includes(status)} onChange={e => send({ type: 'set-status-filter', filter: { preset: 'custom', statuses: e.target.checked ? [...selected, status] : selected.filter(s => s !== status) } })} />{status}</label>)}</div>
      {!options.length && <p>Status options unavailable</p>}
      <div className="ov-filters"><button type="button" aria-pressed={state.exceptionsOnly} onClick={() => send({ type: 'set-exceptions', enabled: !state.exceptionsOnly })}>◇ Gaps only</button><button type="button" disabled={!gaps.length} onClick={() => send({ type: 'flash', targets: gaps })}>✧ Find gaps</button><button type="button" aria-pressed={state.linksVisible !== false} onClick={() => send({ type: 'set-links', visible: state.linksVisible === false })}>Links</button></div>
    </section>}
    {advanced === 'fields' && <section className="ov-field-palette" id="floor-fields" aria-label="Fields">
      {floorFields.map(f => <button key={f.id} type="button" draggable onDragStart={e => { e.dataTransfer.setData('text/plain', f.id); e.dataTransfer.effectAllowed = 'copy' }} aria-pressed={chosen === f.id} onClick={() => setChosen(f.id)}><small>{f.source === 'worker' ? 'Worker' : 'Work'}</small> {f.label} <span aria-hidden="true">⠿</span></button>)}
      {chosen && <div className="ov-placement" role="group" aria-label={`Place ${floorFields.find(f => f.id === chosen)!.label}`}><span>{floorFields.find(f => f.id === chosen)!.label} →</span>{(['outer', 'inner', 'order'] as const).map(slot => <button key={slot} type="button" onClick={() => place(slot, chosen)}>{slot}</button>)}</div>}
    </section>}
    </section>}
  </div>
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { directNeighbors, emptySearch, hasSearch, searchIndex, searchSeeds, type SearchFilter, type SearchHit } from '../shared/smartSearch'
import { homeLabel } from '../shared/reconciliationLabels'
import { patternDefinitions, patternNames, patterns, sceneWorkHealth, type Pattern } from '../shared/workHealth'
import { statusProjection } from '../shared/floorOrganization'
import { readJSON, writeJSON } from '../lib/uiPrefs'
import type { FloorScene, PresentationAction, PresentationState, Target } from './presentation'
import './smartSearch.css'

function MatchSnippet({ hit }: { hit: SearchHit }) {
  const start = Math.max(0, (hit.ranges[0]?.[0] ?? 0) - 50), end = Math.min(hit.field.text.length, start + 180)
  const text = hit.field.text.slice(start, end)
  return <span className="ov-search-snippet">{start ? '…' : ''}{text.split('').map((character, offset) => hit.ranges.some(([a, b]) => start + offset >= a && start + offset <= b)
    ? <mark key={offset}>{character}</mark> : character)}{end < hit.field.text.length ? '…' : ''}</span>
}

export function SmartSearch({ scene, state, send, now, open, activeSession, onOpen, onApply, onRestore, onChoose, onClear }: {
  scene: FloorScene; state: PresentationState; send: (action: PresentationAction) => void; now: number
  open: boolean; activeSession: boolean; onOpen: () => void; onApply: () => void; onRestore: () => void; onChoose: (target: Target) => void; onClear: () => void
}) {
  const filter = state.search ?? emptySearch(), input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null)
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useState<Pattern[]>(() => {
    const saved = readJSON<unknown>('tinstar.search.recent-patterns', [])
    return Array.isArray(saved) ? saved.filter((item): item is Pattern => typeof item === 'string' && patterns.includes(item as Pattern)).slice(0, 5) : []
  })
  const health = useMemo(() => open ? sceneWorkHealth(scene, now) : [], [scene, now, open])
  const seeds = useMemo(() => open && (filter.patterns.length || filter.facets.length) ? directNeighbors(scene, searchSeeds(scene, filter, now)) : new Set<string>(), [scene, filter, now, open])
  const hits = useMemo(() => open ? searchIndex(scene).search(filter.query, now).filter(hit => !filter.patterns.length && !filter.facets.length || seeds.has(hit.document.key)).slice(0, 30) : [], [scene, filter, seeds, open, now])
  const base = useMemo(() => open ? statusProjection(scene, { ...state, search: emptySearch(), searchReveal: null }, now) : { cards: [], workers: [] }, [scene, state, now, open])
  const baseKeys = new Set([...base.cards.map(card => `card:${card.id}`), ...base.workers.map(worker => `execution:${worker.id}`)])
  useEffect(() => { if (open) input.current?.focus({ preventScroll: true }) }, [open])
  useEffect(() => { setActive(0) }, [filter.query, filter.patterns, filter.facets])
  const change = (search: SearchFilter) => send({ type: 'set-search', search })
  const togglePattern = (pattern: Pattern) => {
    const next = [pattern, ...recent.filter(value => value !== pattern)].slice(0, 5)
    setRecent(next); writeJSON('tinstar.search.recent-patterns', next)
    change({ ...filter, patterns: filter.patterns.includes(pattern) ? filter.patterns.filter(value => value !== pattern) : [...filter.patterns, pattern] })
    input.current?.focus()
  }
  const facets = (field: SearchFilter['facets'][number]['field']) => {
    if (field === 'machine') return [...new Set(scene.executions.flatMap(worker => worker.placement.machine ? [worker.placement.machine] : []))].map(value => ({ value, label: value }))
    if (field === 'manager') return [...new Set(scene.coverage.homes.map(home => homeLabel(home.source)))].map(value => ({ value, label: value }))
    if (field === 'entity') return [...scene.cards.map(card => ({ value: card.id, label: String(card.source.properties.Name?.value || card.id) })), ...scene.executions.map(worker => ({ value: worker.id, label: worker.identity.task_id || worker.id }))]
    const ids = new Set(scene.cards.flatMap(card => {
      const property = card.source.properties.Initiative
      const value = property && ['relation', 'select', 'rich_text'].includes(property.type ?? '') ? property.value : null
      return (Array.isArray(value) ? value : [value]).filter((id): id is string => typeof id === 'string' && !!id.trim()).map(id => id.trim())
    }))
    return [...ids].map(value => ({ value, label: String(scene.cards.find(card => card.id === value)?.source.properties.Name?.value || value) }))
  }
  const activeIndex = Math.max(0, Math.min(active, hits.length - 1))
  const activeHit = hits[activeIndex]
  const matchedCardIds = activeHit ? activeHit.document.target.kind === 'card' ? [activeHit.document.target.id] : scene.claims.filter(link => link.executionId === activeHit.document.target.id && link.verification === 'confirmed' && link.state === 'current' && link.basis === 'explicit').map(link => link.cardId) : []
  return <div className="ov-smart-search">
    <button ref={trigger} type="button" className="ov-search-trigger" aria-label="Smart Search (Ctrl or Command K)" aria-keyshortcuts="Control+k Meta+k" aria-expanded={open} aria-controls="ov-search-panel" onClick={onOpen}>⌕<span> Search</span></button>
    {hasSearch(filter) && <button type="button" className="ov-search-clear" onClick={onClear} aria-label="Clear Smart Search">×</button>}
    {activeSession && !open && <button type="button" className="ov-search-back" onClick={onRestore}>← Back</button>}
    <div className="ov-search-chips" aria-label="Smart Search filters">
      {!!filter.query.trim() && <button type="button" onClick={() => change({ ...filter, query: '' })} aria-label="Remove search text">{filter.query} ×</button>}
      {filter.patterns.map(pattern => <button type="button" key={pattern} onClick={() => togglePattern(pattern)} aria-label={`Remove pattern ${patternNames[pattern]}`}>{patternNames[pattern]} ×</button>)}
      {filter.facets.map((facet, index) => <button type="button" key={`${facet.field}:${facet.value}`} onClick={() => change({ ...filter, facets: filter.facets.filter((_, i) => i !== index) })} aria-label={`Remove ${facet.field}: ${facet.value}`}>{facet.field}: {facets(facet.field).find(item => item.value === facet.value)?.label ?? facet.value} ×</button>)}
    </div>
    {open && <section id="ov-search-panel" className="ov-search-panel" aria-label="Smart Search" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onRestore(); trigger.current?.focus({ preventScroll: true }) }
    }}>
      <header><strong>Smart Search</strong><button type="button" aria-label="Back to previous Overview" onClick={onRestore}>×</button></header>
      <label className="ov-search-input">Find names, IDs and text
        <input ref={input} role="combobox" aria-label="Find names, IDs and text" aria-autocomplete="list" aria-expanded="true" aria-controls="ov-search-results" aria-activedescendant={activeHit ? `ov-search-hit-${activeIndex}` : undefined} value={filter.query} maxLength={512} placeholder={'Names, IDs, "exact phrase"…'} onChange={event => change({ ...filter, query: event.target.value })} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(value => Math.max(0, Math.min(hits.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1)))) }
          if (event.key === 'Enter' && activeHit) { event.preventDefault(); onChoose(activeHit.document.target) }
        }} />
      </label>
      <div className="ov-search-patterns" role="group" aria-label="Operational patterns">{[...recent, ...patterns.filter(pattern => !recent.includes(pattern))].map(pattern => {
        const available = !patternDefinitions[pattern].unavailable && health.some(item => item.patterns[pattern].outcome !== 'unavailable')
        const reason = patternDefinitions[pattern].unavailable ?? (available ? patternDefinitions[pattern].rule : health[0]?.patterns[pattern].evidence.at(-1) ?? 'No authorized work observations')
        return <button type="button" key={pattern} disabled={!available && !filter.patterns.includes(pattern)} aria-pressed={filter.patterns.includes(pattern)} title={reason} onClick={() => togglePattern(pattern)}>{patternNames[pattern]}{!available ? ' · unavailable' : ''}{recent.includes(pattern) ? ' ↺' : ''}</button>
      })}</div>
      <div className="ov-search-facets">{(['entity', 'initiative', 'machine', 'manager'] as const).map(field => <label key={field}>{field}<select aria-label={`Search ${field}`} value={filter.facets.find(facet => facet.field === field)?.value ?? ''} onChange={event => change({ ...filter, facets: [...filter.facets.filter(facet => facet.field !== field), ...(event.target.value ? [{ field, value: event.target.value }] : [])] })}><option value="">Any {field}</option>{facets(field).map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>)}</div>
      <p className="ov-search-note">AND across chips. Search uses verified relationships. Select an outside-view result to reveal it temporarily.</p>
      <div id="ov-search-results" role="listbox" aria-label="Search results">{hits.map((hit, index) => <button type="button" role="option" id={`ov-search-hit-${index}`} aria-selected={index === activeIndex} key={hit.document.key} onFocus={() => setActive(index)} onMouseEnter={() => setActive(index)} onClick={() => onChoose(hit.document.target)}>
        <strong>{hit.document.target.kind === 'card' ? '▤' : '◇'} {hit.document.title}</strong>
        {!baseKeys.has(hit.document.key) && <small>Outside current view</small>}
        <MatchSnippet hit={hit} /><small>{hit.field.name} · {hit.field.source} · {scene.searchReadFailed ? 'last known · scene read unavailable' : hit.document.coverage}{hit.document.expiresAt && Date.parse(hit.document.expiresAt) <= now ? ' · stale' : ''}</small>
      </button>)}</div>
      {!hits.length && <p role="status">No matches in available indexed records. Check source coverage below.</p>}
      {activeHit && <details className="ov-search-why"><summary>Why matched? · {activeHit.document.title}</summary><p>{activeHit.field.name} · {activeHit.field.source} · observed {activeHit.document.observedAt ?? 'unknown'}</p>{matchedCardIds.map(id => {
        const item = health.find(item => item.cardId === id)
        return <div key={id}>{(filter.patterns.length ? filter.patterns : ['active' as const]).map(pattern => <div key={pattern}><strong>{filter.patterns.length ? `${patternNames[pattern]} · ${item?.patterns[pattern].outcome ?? 'unavailable'}` : 'Execution evidence'}</strong><ul>{item?.patterns[pattern].evidence.map((text, index) => <li key={index}>{text}</li>)}</ul></div>)}</div>
      })}</details>}
      <details className="ov-search-coverage"><summary>Index coverage & pattern definitions</summary>{(scene.searchIndex?.notes ?? ['Scene metadata only; card prose and comments unavailable.']).map(note => <p key={note}>{note}</p>)}<p>Last-known source data stays labeled; missing observations never prove absence.</p>{patterns.map(pattern => <p key={pattern}><strong>{patternNames[pattern]}</strong>: {patternDefinitions[pattern].rule}{patternDefinitions[pattern].unavailable && ` Unavailable: ${patternDefinitions[pattern].unavailable}`}</p>)}</details>
      <footer><button type="button" onClick={() => { onRestore(); trigger.current?.focus({ preventScroll: true }) }}>Back to previous view · Esc</button><button type="button" onClick={() => { onApply(); trigger.current?.focus({ preventScroll: true }) }}>Apply filters</button></footer>
    </section>}
  </div>
}

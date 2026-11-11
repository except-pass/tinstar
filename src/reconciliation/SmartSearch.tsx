import { useEffect, useMemo, useRef, useState } from 'react'
import { SmartSearchIndex, searchIndex } from '../shared/smartSearch'
import type { SearchDocument } from '../shared/searchDocuments'
import { statusProjection } from '../shared/floorOrganization'
import type { FloorScene, PresentationState, Target } from './presentation'
import './smartSearch.css'

function context(document: SearchDocument) {
  if (document.target.kind === 'pull') return 'GitHub PR'
  if (document.entity) return `${document.entity[0]!.toUpperCase()}${document.entity.slice(1)} · ${document.focusTargets?.length ?? 0} ${document.entity === 'initiative' ? 'tasks' : 'workers'}`
  const fields = document.fields
  const type = document.target.kind === 'card' ? 'Notion task' : 'Worker'
  const detail = fields.find(field => field.name === 'Initiative') ?? fields.find(field => field.name === 'Machine') ?? fields.find(field => field.name === 'Status')
  return `${type}${detail ? ` · ${detail.text.slice(0, 90)}` : ''}`
}

/** A draft query never changes the floor. Selecting a suggestion starts focus. */
export function SmartSearch({ scene, state, now, open, focused, onOpen, onDismiss, onRestore, onChoose, documents, scope }: {
  scope?: 'releases'
  documents?: SearchDocument[]
  scene: FloorScene; state: PresentationState; now: number; open: boolean; focused: boolean
  onOpen: () => void; onDismiss: () => void; onRestore: () => void
  onChoose: (target: Target, targets?: Target[], initiative?: string) => void
}) {
  const input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null), host = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState(''), [active, setActive] = useState(0)
  // Clear during render, not in an effect. The effect ran after paint and
  // discarded a query typed in that gap (the empty-palette status stayed up).
  const [seenOpen, setSeenOpen] = useState(open)
  if (open !== seenOpen) {
    setSeenOpen(open)
    if (open) {
      setQuery('')
      setActive(0)
    }
  }
  const index = useMemo(() => { if (!documents) return searchIndex(scene); const index = new SmartSearchIndex(); index.update(documents); return index }, [scene, documents])
  const hits = useMemo(() => open && query.trim() ? index.search(query, now).slice(0, 8) : [], [index, query, now, open])
  const base = useMemo(() => open ? statusProjection(scene, { ...state, searchReveal: null, searchFocus: undefined }, now) : { cards: [], workers: [] }, [scene, state, now, open])
  const baseKeys = new Set([...base.cards.map(card => `card:${card.id}`), ...base.workers.map(worker => `execution:${worker.id}`)])
  const activeIndex = Math.min(active, Math.max(0, hits.length - 1)), activeHit = hits[activeIndex]
  useEffect(() => { if (open) input.current?.focus({ preventScroll: true }) }, [open])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) onDismiss() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, onDismiss])
  const dismiss = () => { onDismiss(); trigger.current?.focus({ preventScroll: true }) }
  const choose = (document: SearchDocument) => onChoose(document.target, document.focusTargets, document.entity === 'initiative' ? document.key.slice('initiative:'.length) : undefined)
  return <div className="ov-smart-search" ref={host}>
    <button ref={trigger} type="button" className="ov-search-trigger" aria-label="Smart Search (Ctrl or Command K)" aria-keyshortcuts="Control+k Meta+k" aria-expanded={open} aria-controls="ov-search-panel" onClick={open ? dismiss : onOpen}>⌕<span> Search</span></button>
    {focused && <button type="button" className="ov-search-back" onClick={onRestore} aria-label="Clear search focus" title="Restore previous view · Esc">◎ ×</button>}
    {open && <section id="ov-search-panel" className="ov-search-panel" role="dialog" aria-label="Smart Search" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss() }
    }}>
      <div className="ov-search-input"><span aria-hidden="true">⌕</span><input ref={input} role="combobox" aria-label="Find names, IDs and text" aria-autocomplete="list" aria-expanded="true" aria-controls="ov-search-results" aria-activedescendant={activeHit ? `ov-search-hit-${activeIndex}` : undefined} value={query} maxLength={512} placeholder="Search tasks, workers, machines, PRs…" onChange={event => { setQuery(event.target.value); setActive(0) }} onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(value => Math.max(0, Math.min(hits.length - 1, value + (event.key === 'ArrowDown' ? 1 : -1)))) }
        if (event.key === 'Enter' && activeHit) { event.preventDefault(); choose(activeHit.document) }
      }} /><button type="button" aria-label="Close search palette" onClick={dismiss}>Esc</button></div>
      <div id="ov-search-results" role="listbox" aria-label="Search results">{hits.map((hit, index) => <button type="button" role="option" aria-label={`${hit.document.title}. ${context(hit.document)}${hit.document.target.kind !== 'pull' && !baseKeys.has(hit.document.key) && !hit.document.entity ? ' · Outside current view' : ''}`} id={`ov-search-hit-${index}`} aria-selected={index === activeIndex} key={hit.document.key} onFocus={() => setActive(index)} onMouseEnter={() => setActive(index)} onClick={() => choose(hit.document)}>
        <span className="ov-search-icon" aria-hidden="true">{hit.document.entity === 'machine' ? '▣' : hit.document.entity ? '◈' : hit.document.target.kind === 'card' ? '▤' : '◇'}</span>
        <span><strong>{hit.document.title}</strong><small>{context(hit.document)}{hit.document.target.kind !== 'pull' && !baseKeys.has(hit.document.key) && !hit.document.entity ? ' · Outside current view' : ''}{scene.searchReadFailed || hit.document.expiresAt && Date.parse(hit.document.expiresAt) <= now ? ' · last known' : ''}</small></span>
      </button>)}</div>
      {!hits.length && <p role="status">{query.trim() ? 'No matches in available records.' : scope === 'releases' ? 'Type to find PRs and linked tasks.' : 'Type to find tasks, workers, machines, managers, initiatives and linked PRs.'}</p>}
      <footer>↑↓ Navigate <span>↵ {scope === 'releases' ? 'Focus PR' : 'Focus in Overview'}</span><span>Esc Close</span></footer>
    </section>}
  </div>
}

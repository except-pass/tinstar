import { emptySearch, type SearchFilter } from '../shared/smartSearch'
import { patternNames } from '../shared/workHealth'
import type { FloorScene, PresentationAction, PresentationState } from './presentation'

/** Present the existing explicit predicates; organizer and Search focus are not filters. */
export function ActiveFilters({ scene, state, send, onEditScope }: { scene: FloorScene; state: PresentationState; send: (action: PresentationAction) => void; onEditScope: (button: HTMLButtonElement) => void }) {
  const search = state.search ?? emptySearch(), selection = state.donutFilter ?? { cards: [], workers: [] }
  // Reuse the existing view action so editing facets does not dismiss a temporary
  // Search reveal, clear its navigation, or change the saved restore stack.
  const editFacets = (value: SearchFilter) => {
    const { searchReveal, searchFocus, selection, collapsed, navigation, exceptionsOnly, roadmapExpanded, organizer, statusFilter, donutFilter, linksVisible, arrangement, sort } = state
    send({ type: 'restore-search-view', view: { search: value, searchReveal, searchFocus, selection, collapsed, navigation, exceptionsOnly, roadmapExpanded, organizer, statusFilter, donutFilter, linksVisible, arrangement, sort } })
  }
  const terms: Array<{ key: string; kind: string; value: string; remove: () => void }> = [
    ...search.facets.map((facet, index) => ({ key: `facet:${index}`, kind: `${facet.field[0]!.toUpperCase()}${facet.field.slice(1)}`, value: facet.field === 'initiative' ? String(scene.cards.find(card => card.id === facet.value)?.source.properties.Name?.value ?? facet.value) : facet.value, remove: () => editFacets({ ...search, facets: search.facets.filter((_, i) => i !== index) }) })),
    ...search.patterns.map(pattern => ({ key: `pattern:${pattern}`, kind: 'Pattern', value: patternNames[pattern], remove: () => editFacets({ ...search, patterns: search.patterns.filter(value => value !== pattern) }) })),
    ...(['workers', 'cards'] as const).flatMap(domain => selection[domain].map(status => ({ key: `${domain}:${status}`, kind: domain === 'cards' ? 'Cards' : 'Workers', value: status, remove: () => send({ type: 'set-donut-filter', filter: { ...selection, [domain]: selection[domain].filter(value => value !== status) } }) }))),
    ...(state.exceptionsOnly ? [{ key: 'gaps', kind: 'View', value: 'Gaps only', remove: () => send({ type: 'set-exceptions', enabled: false }) }] : []),
  ]
  const scope = state.statusFilter && state.statusFilter.preset !== 'operational'
    ? state.statusFilter.preset === 'all' ? 'All' : `Custom - ${state.statusFilter.statuses.join(', ') || 'No statuses'}`
    : null
  const count = terms.length + (scope ? 1 : 0)
  const clear = () => {
    if (search.facets.length || search.patterns.length) editFacets({ ...search, facets: [], patterns: [] })
    send({ type: 'clear-donut-filter' })
    if (state.exceptionsOnly) send({ type: 'set-exceptions', enabled: false })
  }
  return <aside className="ov-active-panel" aria-label="Applied filters">
    <div className="ov-active-title"><span className="ov-active-heading"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M4 5h16l-6.5 7.5V19l-3.5 2v-8.5z" /></svg>Active filters <b>{count}</b></span><button type="button" className="ov-clear-filters" disabled={!terms.length} onClick={clear}>Clear all</button></div>
    <div className="ov-filter-chips" aria-live="polite">{count ? <>{scope && <button type="button" aria-label={`Edit Status scope: ${scope}`} title="Edit status scope in Customize" aria-controls="floor-filters" onClick={event => onEditScope(event.currentTarget)}><span className="ov-filter-kind">Status scope:</span> <strong>{scope}</strong></button>}{terms.map(term => <button type="button" key={term.key} aria-label={`Remove ${term.kind}: ${term.value}`} title={`Remove ${term.kind}: ${term.value}`} onClick={term.remove}><span className="ov-filter-kind">{term.kind}:</span> <strong>{term.value}</strong><span aria-hidden="true">×</span></button>)}</> : <span className="ov-no-filters">No active filters</span>}</div>
  </aside>
}

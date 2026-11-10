import { useEffect, useState } from 'react'
import type { SceneCard } from '../server/reconciliation/scene'
import { cardTitle } from './overviewModel'
import { waitingForTypes, type WaitingForType, type waitingForGroups } from './waitingFor'

export function WaitingForWork({ projection, type, onType, open, onToggle, searchKey, selected, revealed, flashed, onSelect, onHover, partial, failed, observedAt }: {
  projection: ReturnType<typeof waitingForGroups>; type: 'All' | WaitingForType; onType: (type: 'All' | WaitingForType) => void
  open: ReadonlySet<string>; onToggle: (key: string) => void; searchKey?: string; selected?: string; revealed: ReadonlySet<string>
  flashed: (id: string) => boolean; onSelect: (id: string) => void; onHover: (card: SceneCard | null) => void
  partial: boolean; failed: boolean; observedAt: string | null
}) {
  const [searchClosed, setSearchClosed] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => { setSearchClosed(new Set()) }, [searchKey])
  const toggle = (key: string) => {
    if (!searchKey) { onToggle(key); return }
    setSearchClosed(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }
  const row = (card: SceneCard) => <button type="button" key={card.id} className={`ov-item ov-card ov-waiting-card${selected === card.id ? ' selected' : ''}${revealed.has(`card:${card.id}`) ? ' related' : ''}${flashed(card.id) ? ' flashed' : ''}`}
    data-semantic-id={`card:${card.id}`} data-entity-id={card.id} title={cardTitle(card)} aria-label={cardTitle(card)}
    onClick={() => onSelect(card.id)} onMouseEnter={() => onHover(card)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(card)} onBlur={() => onHover(null)}>
    <span>{cardTitle(card)}</span>
  </button>
  const categories = projection.categories.filter(category => type === 'All' || category.type === type)
  const shown = categories.reduce((sum, category) => sum + category.groups.reduce((sum, group) => sum + group.cards.length, 0), 0)
  return <section className="ov-waiting-work" aria-label="Waiting For work">
    <header className="ov-waiting-head"><strong>Work</strong><small>Waiting For · {failed && projection.count === 0 ? 'unavailable' : partial ? `${projection.count} shown` : projection.count}</small><div role="group" aria-label="Waiting For Type">{(['All', ...waitingForTypes] as const).map(value => <button key={value} type="button" aria-pressed={type === value} onClick={() => onType(value)}>{value}</button>)}</div></header>
    {(failed || partial) && <p className="ov-waiting-notice" role="status">{failed ? 'Could not refresh Waiting For. Showing the last known cards.' : `Partial results · ${projection.count} shown`}{observedAt && <time dateTime={observedAt}> · Last known {new Date(observedAt).toLocaleString()}</time>}</p>}
    {categories.map(category => category.groups.length > 0 && <section key={category.type} className="ov-waiting-category" aria-label={`${category.type} dependencies`}>
      <h3><span>{category.type}</span><span>{category.groups.reduce((sum, group) => sum + group.cards.length, 0)}</span></h3>
      {category.groups.map(group => {
        const expanded = searchKey ? !searchClosed.has(group.key) : open.has(group.key)
        const destination = group.target
        return <section key={group.key} className="ov-waiting-dependency" data-dependency-key={group.key}>
          <div className="ov-waiting-dependency-head"><button type="button" aria-expanded={expanded} aria-label={`${group.label}, ${group.cards.length} ${group.cards.length === 1 ? 'card' : 'cards'}`} title={group.label === group.id ? group.id : `${group.label} · ${group.id}`} onClick={() => toggle(group.key)}><span className="ov-waiting-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span><strong>{group.label}</strong><small>{group.cards.length} {group.cards.length === 1 ? 'card' : 'cards'}</small></button>
            {destination && (destination.kind === 'url' ? <a href={destination.url} target="_blank" rel="noreferrer" aria-label={`Open ${group.label}`} title={destination.url}>↗</a> : <button type="button" className="ov-waiting-target" aria-label={`Open ${group.label} in Inspector`} onClick={() => {
              // Resolved by the same loaded record used to construct this projection.
              onSelect(destination.id)
            }}>↗</button>)}
          </div>
          {expanded && <div className="ov-waiting-children">{group.cards.map(row)}</div>}
        </section>
      })}
    </section>)}
    {projection.unclassified.length > 0 && <section className="ov-waiting-category ov-waiting-unclassified" aria-label="Needs classification"><h3><span>Needs classification</span><span>{projection.unclassified.length}</span></h3>{projection.unclassified.map(row)}</section>}
    {shown === 0 && (type !== 'All' || projection.unclassified.length === 0) && !partial && !failed && <p className="ov-empty">{projection.count || type !== 'All' ? 'No Waiting For cards in this group' : 'Nothing is Waiting For right now'}</p>}
  </section>
}

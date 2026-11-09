import { useLayoutEffect, useRef, useState } from 'react'
import { useDeskWorkspace } from '../ask/DeskWorkspace'
import { useViewSnapshot } from '../ask/workspaceHistory'
import { AskSurface } from '../ask/AskSurface'
import type { QueueItem } from '../server/reconciliation/queue'
import { cardTitle } from './overviewModel'
import './decisions.css'
import { decodeRequestText } from './requestText'

export const readinessLabels = {
  'ready-now': 'Ready now',
  'needs-readiness-verification': 'Needs readiness verification',
  'future-or-conditional': 'Future or conditional',
}
interface DecisionEntry { key: string; item: QueueItem; id: string | null; title: string; action: string | null }
const sourceStale = (item: QueueItem, now: number) => item.sources.some(source => !['fresh', 'partial'].includes(source.status) || !!source.expiresAt && Date.parse(source.expiresAt) <= now)

/** The list is a projection of the existing queue; card focus belongs to the
 * shared presentation, including when this section unmounts. */
export function Decisions() {
  const { scene, error, queue, queueError, state, send, connection, bridgeError, now, views } = useDeskWorkspace()
  const [query, setQuery] = useState('')
  const list = useRef<HTMLDivElement>(null)
  const interaction = useRef(0)
  const [expiredFlash, setExpiredFlash] = useState<number | null>(null)
  const selectedId = state.selection?.kind === 'card' ? state.selection.id : null
  const flash = state.flash && state.flash.until > Date.now() && state.flash.until !== expiredFlash ? state.flash : null
  useViewSnapshot(views, 'decisions', () => ({ query }), saved => setQuery(saved.query))
  const entries = (queue?.items ?? []).flatMap<DecisionEntry>(item => {
    if (!item.cardIds.length) return [{ key: item.id, item, id: null, title: decodeRequestText(item.title), action: item.action ? decodeRequestText(item.action) : null }]
    return item.cardIds.map(id => {
      const card = scene?.cards.find(card => card.id === id)
      return { key: `${item.id}:${id}`, item, id, title: card ? cardTitle(card) : decodeRequestText(item.title), action: item.action ? decodeRequestText(item.action) : card?.nextAction ?? null }
    })
  })
  const selected = selectedId ? entries.find(entry => entry.id === selectedId) : undefined
  const matches = (entry: typeof entries[number]) => `${entry.title} ${entry.id ?? ''} ${entry.item.title} ${entry.action ?? ''} ${readinessLabels[entry.item.readiness]}`.toLowerCase().includes(query.trim().toLowerCase())
  const visible = entries.filter(entry => matches(entry) || !!entry.id && entry.id === selectedId || !!entry.id && flash?.ids.includes(`card:${entry.id}`))
  const unavailable = !!queueError || !!error
  const incomplete = queue && [queue.coverage.intentions, ...queue.coverage.fleet].some(source => !['fresh', 'partial'].includes(source.status) || source.coverage !== 'complete' || !!source.expiresAt && Date.parse(source.expiresAt) <= now)
  const canFocus = (id: string) => !unavailable && !!scene?.cards.some(card => card.id === id)
  useLayoutEffect(() => {
    if (!selectedId) return
    list.current?.querySelector<HTMLElement>(`[data-card-id="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [state.selection, !!selected])
  useLayoutEffect(() => {
    const current = state.flash, viewport = list.current
    if (!current || current.until <= Date.now() || !viewport) return
    const row = Array.from(viewport.querySelectorAll<HTMLElement>('[data-card-id]')).find(row => current.ids.includes(`card:${row.dataset.cardId}`))
    const scroll = viewport.scrollTop, before = interaction.current
    row?.scrollIntoView({ block: 'nearest' })
    const timer = setTimeout(() => {
      setExpiredFlash(current.until)
      // A wheel, click, search or keyboard input takes ownership of the list.
      if (interaction.current === before) viewport.scrollTop = scroll
    }, Math.max(0, current.until - Date.now()))
    return () => clearTimeout(timer)
  }, [state.flash])
  return <section className="decisions" aria-label="Decisions" data-presentation-scene data-scene-id={connection?.scene_id} data-revision={state.revision} onPointerDown={() => interaction.current++} onKeyDown={() => interaction.current++} onWheel={() => interaction.current++}>
    <header><span className="cockpit-eyebrow">SHARED QUEUE</span><h1>Decisions</h1><p>Browse requests and prerequisites. Select a card to work on it together from Your desk.</p></header>
    {bridgeError && <p role="status">MCP connection delayed. Local browsing remains available.</p>}
    {unavailable && <p role="status">{queueError ?? error} Shared card focus is unavailable until sources recover.</p>}
    {incomplete && <p role="status">Some sources are stale or unavailable. Retained requests are last-known; this list cannot establish that all work is clear.</p>}
    <label className="decisions-search">Search decisions<input type="search" value={query} onChange={event => { interaction.current++; setQuery(event.target.value) }} placeholder="Title, card ID or next action" /></label>
    <div className="decisions-layout">
      <div className="decisions-list" ref={list} aria-label="Decision requests">
        {!queue && !queueError && <p role="status">Reading decision sources…</p>}
        {queue && !visible.length && <p role="status">{unavailable || incomplete ? 'No matching requests in available records. Source coverage is incomplete.' : query ? 'No matching requests.' : 'No requests in the current queue. This does not certify all work is clear.'}</p>}
        {visible.map(entry => {
          const { item, id } = entry
          const flashed = !!id && !!flash?.ids.includes(`card:${id}`)
          const details = <><strong>{entry.title}</strong><small>{readinessLabels[item.readiness]}{sourceStale(item, now) ? ' · Source stale / unavailable' : ''}</small>{entry.action && <span>{entry.action}</span>}{!matches(entry) && <small>Shared target shown outside search</small>}</>
          return id ? <AskSurface as="div" subject={{ cardId: id }} key={entry.key}><button type="button" className={`decisions-row${selectedId === id ? ' selected' : ''}${flashed ? ' flashed' : ''}`} data-card-id={id} aria-pressed={selectedId === id} disabled={!canFocus(id)} onClick={() => send({ type: 'focus', target: { kind: 'card', id }, origin: 'manual' })}>{details}{!canFocus(id) && <small>Card unavailable in the source scene. <span>Use the source link below.</span></small>}</button>{!canFocus(id) && <a href={`https://www.notion.so/${id}`} target="_blank" rel="noreferrer">Read source card ↗</a>}</AskSurface> : <details className="decisions-request" key={entry.key}><summary>{details}</summary><p>No linked card; card focus and flash are unavailable.</p>{item.sources.map((source, index) => <p key={index}>{source.request?.kind} · {source.request?.taskId ?? source.id}{source.action ? ` · ${decodeRequestText(source.action)}` : ''}</p>)}{item.evidence.map(e => <a key={e.url} href={e.url} target="_blank" rel="noreferrer">Read evidence ↗</a>)}</details>
        })}
      </div>
      <aside className="decisions-summary" aria-label="Selected decision">
        {selected ? <AskSurface as="div" subject={{ cardId: selected.id! }}><small>SELECTED CARD</small><h2>{selected.title}</h2><p>{readinessLabels[selected.item.readiness]}</p><p>{selected.action ?? 'Next action not published. Read the source card for context.'}</p><a href={`https://www.notion.so/${selected.id}`} target="_blank" rel="noreferrer">Read Notion card ↗</a>{selected.item.evidence.filter(e => e.kind !== 'card').map(e => <a key={e.url} href={e.url} target="_blank" rel="noreferrer">Read evidence ↗</a>)}<small>{selected.id}</small>{selected.item.reasons.map(reason => <p key={reason}>{reason}</p>)}</AskSurface> : <p>{selectedId ? 'Selected card is unavailable in the current queue. Selection is retained while sources refresh.' : 'Select a card to share its focus with MCP.'}</p>}
      </aside>
    </div>
  </section>
}

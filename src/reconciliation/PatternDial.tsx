import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { dialNames, dialPatterns, freshObservation, patternReminders, sceneWorkHealth, type DialPattern } from '../shared/workHealth'
import { emptySearch } from '../shared/smartSearch'
import { isPlanned, type FloorScene, type PresentationAction, type PresentationState } from './presentation'
import { overviewGroups } from './overviewModel'
import './smartSearch.css'

/** Counts share the normal scene projection, ignoring only the current detent. */
export function patternPreviews(scene: FloorScene, state: PresentationState, now: number) {
  const base = { ...state, search: { ...(state.search ?? emptySearch()), patterns: [] }, searchReveal: null, searchFocus: undefined }
  const ids = new Set(overviewGroups(scene, base, now, !!scene.searchReadFailed).flatMap(group => group.cards.filter(card => state.roadmapExpanded || !isPlanned(scene, card)).map(card => card.id)))
  const health = sceneWorkHealth(scene, now).filter(item => ids.has(item.cardId))
  const sourceUnknown = !!scene.searchReadFailed || !freshObservation(scene.coverage.intentions, now)
  const workersUnknown = !scene.coverage.homes.length || scene.coverage.homes.some(home => !freshObservation(home.observation, now))
  return Object.fromEntries(dialPatterns.map(pattern => {
    const unavailable = pattern === 'all' ? [] : health.filter(item => item.patterns[pattern].outcome === 'unavailable')
    const needsHomes = pattern === 'active' || pattern === 'stalled' || (pattern === 'all' && !!state.donutFilter?.workers.length)
    const reasons = [...new Set([
      ...(sourceUnknown ? [scene.searchReadFailed ? 'Source read failed; showing last known work' : 'Notion source is unavailable, stale or incomplete'] : []),
      ...unavailable.flatMap(item => item.patterns[pattern as Exclude<DialPattern, 'all'>].reason.split('; ')),
      ...(needsHomes ? scene.coverage.homes.filter(home => !freshObservation(home.observation, now)).map(home => `Home snapshot stale or unreadable: ${home.source.home}`) : []),
      ...(needsHomes && !scene.coverage.homes.length ? ['Home snapshot unavailable: no configured home'] : []),
    ])]
    return [pattern, {
      count: pattern === 'all' ? ids.size : health.filter(item => item.patterns[pattern].outcome === 'match').length,
      unknown: sourceUnknown || unavailable.length > 0 || (needsHomes && workersUnknown), reasons,
    }]
  })) as Record<DialPattern, { count: number; unknown: boolean; reasons: string[] }>
}

export function PatternDial({ scene, state, send, now }: { scene: FloorScene; state: PresentationState; send: (action: PresentationAction) => void; now: number }) {
  const selected: DialPattern = dialPatterns.find(pattern => pattern === state.search?.patterns[0]) ?? 'all'
  const counts = useMemo(() => patternPreviews(scene, state, now), [scene, state, now])
  const index = dialPatterns.indexOf(selected), previous = dialPatterns[(index + dialPatterns.length - 1) % dialPatterns.length]!, next = dialPatterns[(index + 1) % dialPatterns.length]!
  const host = useRef<HTMLDivElement>(null), center = useRef<HTMLButtonElement>(null), tip = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(), wheelAt = useRef(-Infinity), touch = useRef<{ x: number; y: number } | null>(null), swiped = useRef(false)
  const [shown, setShown] = useState(false), [pinned, setPinned] = useState(false), [position, setPosition] = useState({ left: 8, top: 56 })
  const stopTimer = () => clearTimeout(timer.current)
  const hide = () => { stopTimer(); setShown(false); setPinned(false) }
  const showLater = () => { stopTimer(); timer.current = setTimeout(() => setShown(true), 400) }
  const choose = (pattern: DialPattern) => { hide(); send({ type: 'set-pattern', pattern: pattern === 'all' ? null : pattern }) }
  const step = (direction: number) => choose(dialPatterns[(index + direction + dialPatterns.length) % dialPatterns.length]!)
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) < 12 || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
      event.preventDefault()
      // Momentum bursts are one gesture. Require a quiet interval before another detent.
      const at = performance.now(), quiet = at - wheelAt.current > 220
      wheelAt.current = at
      if (quiet) step(event.deltaX > 0 ? 1 : -1)
    }
    const element = host.current
    element?.addEventListener('wheel', wheel, { passive: false })
    return () => element?.removeEventListener('wheel', wheel)
  })
  useEffect(() => {
    if (!shown) return
    const outside = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node) && !tip.current?.contains(event.target as Node)) hide() }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('.ov-search-panel')) return
      event.preventDefault(); event.stopPropagation(); hide()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [shown])
  useLayoutEffect(() => {
    if (!shown) return
    const place = () => {
      const box = center.current?.getBoundingClientRect(), height = tip.current?.offsetHeight ?? 160, width = Math.min(330, window.innerWidth - 16)
      if (box) setPosition({ left: Math.max(8, Math.min(window.innerWidth - width - 8, box.left + box.width / 2 - width / 2)), top: box.bottom + height + 10 < window.innerHeight ? box.bottom + 8 : Math.max(8, box.top - height - 8) })
    }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [shown, selected])
  const count = (pattern: DialPattern) => counts[pattern].unknown ? counts[pattern].count ? `${counts[pattern].count}+` : '?' : String(counts[pattern].count)
  const label = (pattern: DialPattern) => `${dialNames[pattern]}, ${count(pattern)} matching tasks${counts[pattern].unknown ? ', incomplete evidence' : ''}`
  return <div className="ov-pattern-dial" ref={host} role="group" aria-label="Operational pattern dial" onKeyDown={event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); step(event.key === 'ArrowRight' ? 1 : -1) }
  }} onPointerDown={event => { swiped.current = false; if (event.pointerType !== 'mouse') { (event.target as HTMLElement).setPointerCapture?.(event.pointerId); touch.current = { x: event.clientX, y: event.clientY }; swiped.current = false } }} onPointerUp={event => {
    const start = touch.current; touch.current = null
    if (!start) return
    const dx = event.clientX - start.x, dy = event.clientY - start.y
    if (Math.abs(dx) > 28 && Math.abs(dx) > Math.abs(dy) * 1.3) { swiped.current = true; step(dx < 0 ? 1 : -1) }
  }} onPointerCancel={() => { touch.current = null }} onClickCapture={event => { if (swiped.current) { swiped.current = false; event.preventDefault(); event.stopPropagation() } }}>
    <button type="button" className="ov-pattern-neighbor" aria-label={`Select ${label(previous)}`} onClick={() => choose(previous)}><span>{dialNames[previous]}</span><small>{count(previous)}</small></button>
    <button ref={center} type="button" className="ov-pattern-selected" aria-label={`${label(selected)}. Show explanation`} aria-describedby="ov-pattern-description" aria-expanded={shown} onMouseEnter={showLater} onMouseLeave={() => { stopTimer(); if (!pinned) setShown(false) }} onFocus={showLater} onBlur={() => { stopTimer(); if (!pinned) setShown(false) }} onClick={() => { stopTimer(); setPinned(!pinned); setShown(!pinned) }}><strong>{dialNames[selected]}</strong><small>{count(selected)}</small><span aria-hidden="true">ⓘ</span></button>
    <button type="button" className="ov-pattern-neighbor" aria-label={`Select ${label(next)}`} onClick={() => choose(next)}><span>{dialNames[next]}</span><small>{count(next)}</small></button>
    <span id="ov-pattern-description" className="ov-sr-only">{patternReminders[selected]}{counts[selected].unknown ? ` ${counts[selected].reasons.join('; ')}. ? means unknown, + means confirmed matches with incomplete coverage.` : ''} Swipe sideways or use Left and Right arrow keys to change pattern.</span>
    {shown && createPortal(<div ref={tip} role="tooltip" className="ov-pattern-tooltip" style={position}><strong>{dialNames[selected]} · {count(selected)} matching tasks</strong><p>{patternReminders[selected]}</p>{counts[selected].unknown && <small>{counts[selected].reasons.join("; ")}. ? means unknown; + means confirmed matches with incomplete coverage.</small>}</div>, document.body)}
  </div>
}

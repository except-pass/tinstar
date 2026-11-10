import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { combinedPatternResult, dialNames, dialPatterns, freshObservation, sceneWorkHealth, patternNames, type DialPattern, type Pattern } from '../shared/workHealth'
import { emptySearch } from '../shared/smartSearch'
import { isPlanned, type FloorScene, type PresentationAction, type PresentationState } from './presentation'
import { overviewGroups } from './overviewModel'
import { patternCheckSummary, type PatternCoverage } from './overviewEvidence'
import './smartSearch.css'

const definitions: Record<DialPattern | Pattern, string> = {
  all: 'All work under your current filters.',
  stalled: 'In Progress work with no confirmed way to advance.',
  active: 'In Progress work with a confirmed way to advance.',
  blocked: 'Work waiting for a named dependency.',
  decision: 'Work that explicitly needs your decision or action.',
  unstaffed: 'In Progress work confirmed to have no assigned worker.',
  mismatch: 'Work status and worker activity disagree.',
  stale: 'Work with no meaningful progress within its expected time.',
  idle: 'Workers waiting with no runnable assigned work.',
}

const HOLD_MS = 500
const HOLD_SLOP = 8
/** Accumulate small pixel deltas before the first detent of a burst. */
const WHEEL_NOTCH_PX = 40
/** A quiet gap lets a new gesture start independently of the previous delta trend. */
const WHEEL_SETTLE_MS = 200

/** Counts share the normal scene projection, ignoring only the current detent. */
export function patternPreviews(scene: FloorScene, state: PresentationState, now: number) {
  const base = { ...state, search: { ...(state.search ?? emptySearch()), patterns: [] }, searchReveal: null, searchFocus: undefined }
  const ids = new Set(overviewGroups(scene, base, now, !!scene.searchReadFailed).flatMap(group => group.cards.filter(card => state.roadmapExpanded || !isPlanned(scene, card)).map(card => card.id)))
  const health = sceneWorkHealth(scene, now).filter(item => ids.has(item.cardId))
  const sourceUnknown = !!scene.searchReadFailed || !freshObservation(scene.coverage.intentions, now)
  const workersUnknown = !scene.coverage.homes.length || scene.coverage.homes.some(home => !freshObservation(home.observation, now))
  return Object.fromEntries(([...dialPatterns, 'idle'] as const).map(pattern => {
    const unavailable = pattern === 'all' ? [] : health.filter(item => item.patterns[pattern].outcome === 'unavailable')
    const needsHomes = !!state.donutFilter?.workers.length || !!state.search?.query.trim() ||
      !!state.search?.facets.some(facet => facet.field === 'machine' || facet.field === 'manager' || facet.field === 'entity')
    const reasons = [...new Set([
      ...(sourceUnknown ? [scene.searchReadFailed ? 'Source read failed; showing last known work' : 'Notion source is unavailable, stale or incomplete'] : []),
      ...unavailable.flatMap(item => item.patterns[pattern as Pattern].reason.split('; ')),
      ...(needsHomes ? scene.coverage.homes.filter(home => !freshObservation(home.observation, now)).map(home => `Home snapshot stale or unreadable: ${home.source.home}`) : []),
      ...(needsHomes && !scene.coverage.homes.length ? ['Home snapshot unavailable: no configured home'] : []),
    ])]
    return [pattern, {
      count: pattern === 'all' ? ids.size : health.filter(item => item.patterns[pattern].outcome === 'match').length,
      unknown: sourceUnknown || unavailable.length > 0 || (needsHomes && workersUnknown), reasons,
      coverage: pattern === 'all' ? null : patternCheckSummary(ids, new Map(health.map(item => [item.cardId, item.patterns[pattern]]))),
    }]
  })) as Record<DialPattern | 'idle', { count: number; unknown: boolean; reasons: string[]; coverage: PatternCoverage | null }>
}

export function PatternDial({ scene, state, send, now, coverage, onInspectCoverage }: { coverage?: PatternCoverage | null; onInspectCoverage?: () => void; scene: FloorScene; state: PresentationState; send: (action: PresentationAction) => void; now: number }) {
  const selected: DialPattern | Pattern = state.search?.patterns[0] ?? 'all'
  const counts = useMemo(() => patternPreviews(scene, state, now), [scene, state, now])
  const selection = state.search?.patterns.length ? state.search.patterns : ['all'] as const
  const combined = selection.length > 1
  const selectedName = selection.map(pattern => pattern === 'idle' ? patternNames.idle : dialNames[pattern]).join(' + ')
  const selectedReminder = combined ? 'Work that meets every selected pattern.' : definitions[selected]
  // A combination uses the same unfiltered universe as each detent preview.
  const combinedPreview = useMemo(() => {
    if (!combined) return null
    const base = { ...state, search: { ...(state.search ?? emptySearch()), patterns: [] }, searchReveal: null, searchFocus: undefined }
    const ids = new Set(overviewGroups(scene, base, now, !!scene.searchReadFailed).flatMap(group => group.cards.filter(card => state.roadmapExpanded || !isPlanned(scene, card)).map(card => card.id)))
    const results = new Map(sceneWorkHealth(scene, now).filter(item => ids.has(item.cardId)).map(item => [item.cardId, combinedPatternResult(item, state.search!.patterns)]))
    return { count: [...results.values()].filter(result => result.outcome === 'match').length, coverage: patternCheckSummary(ids, results) }
  }, [combined, scene, state, now])
  const scopedCoverage = selected === 'all' ? null : coverage !== undefined ? coverage : combinedPreview?.coverage ?? counts[selected].coverage
  const confirmed = scopedCoverage?.confirmed ?? combinedPreview?.count ?? counts[selected].count
  const partial = !!scopedCoverage || !combined && selected !== 'all' && counts[selected].unknown
  const selectedCount = `${confirmed}${partial ? ' confirmed' : ''}`
  const index = Math.max(0, dialPatterns.indexOf(selected as DialPattern)), previous = dialPatterns[(index + dialPatterns.length - 1) % dialPatterns.length]!, next = dialPatterns[(index + 1) % dialPatterns.length]!
  const host = useRef<HTMLDivElement>(null), center = useRef<HTMLButtonElement>(null), tip = useRef<HTMLDivElement>(null), menuEl = useRef<HTMLDivElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(), holdTimer = useRef<ReturnType<typeof setTimeout>>(), wheelAt = useRef(-Infinity), wheelAcc = useRef(0), wheelHeld = useRef(false), wheelDelta = useRef(0)
  const touch = useRef<{ x: number; y: number } | null>(null), holdOrigin = useRef<{ x: number; y: number } | null>(null)
  const swiped = useRef(false), held = useRef(false), restoring = useRef(false), menuRef = useRef(false)
  const [shown, setShown] = useState(false), [pinned, setPinned] = useState(false), [menu, setMenu] = useState(false), [active, setActive] = useState(index), [position, setPosition] = useState({ left: 8, top: 56 }), [menuPos, setMenuPos] = useState({ left: 8, top: 56 })
  menuRef.current = menu
  const stopTimer = () => clearTimeout(timer.current)
  const stopHold = () => { clearTimeout(holdTimer.current); holdOrigin.current = null }
  const hide = () => { stopTimer(); setShown(false); setPinned(false) }
  const showLater = () => { if (menuRef.current) return; stopTimer(); timer.current = setTimeout(() => setShown(true), 400) }
  const focusDial = () => { restoring.current = true; center.current?.focus(); restoring.current = false }
  const closeMenu = (restore: boolean) => { setMenu(false); if (restore) focusDial() }
  const choose = (pattern: DialPattern, restore = false) => { hide(); closeMenu(restore); send({ type: 'set-pattern', pattern: pattern === 'all' ? null : pattern }) }
  const step = (direction: number) => choose(dialPatterns[(index + direction + dialPatterns.length) % dialPatterns.length]!)
  const openMenu = () => { hide(); setActive(index); setMenu(true) }
  const count = (pattern: DialPattern | Pattern) => `${counts[pattern].count}${pattern !== 'all' && counts[pattern].unknown ? ' confirmed' : ''}`
  const label = (pattern: DialPattern | Pattern) => `${pattern === 'idle' ? patternNames.idle : dialNames[pattern]}, ${count(pattern)}${counts[pattern].coverage ? `, ${counts[pattern].coverage!.label}` : ''}`
  const reminder = (pattern: DialPattern) => `${dialNames[pattern]}: ${definitions[pattern]}`
  const neighbor = (pattern: DialPattern) => <span className="ov-pattern-value"><span>{dialNames[pattern]} <b>{count(pattern)}</b></span>{pattern !== 'all' && counts[pattern].coverage && <small className="ov-pattern-coverage">{counts[pattern].coverage!.label}</small>}</span>
  useEffect(() => () => { clearTimeout(timer.current); clearTimeout(holdTimer.current) }, [])
  useEffect(() => {
    const wheel = (event: WheelEvent) => {
      if (menuRef.current) return
      const dx = event.deltaX, dy = event.deltaY
      if (dx === 0 && dy === 0) return
      event.preventDefault()
      const at = performance.now(), gap = at - wheelAt.current
      const delta = Math.abs(dy) >= Math.abs(dx) ? dy : dx
      const previousDelta = wheelDelta.current
      if (gap >= WHEEL_SETTLE_MS || Math.sign(delta) !== Math.sign(previousDelta)) {
        wheelAcc.current = 0; wheelHeld.current = false
      }
      wheelAt.current = at
      wheelDelta.current = delta
      const direction = delta > 0 ? 1 : -1
      if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) {
        if (wheelHeld.current) {
          if (Math.abs(delta) < Math.abs(previousDelta)) return
        } else {
          wheelAcc.current += delta
          if (Math.abs(wheelAcc.current) < WHEEL_NOTCH_PX) return
        }
      }
      wheelAcc.current = 0
      wheelHeld.current = true
      step(direction)
    }
    const element = host.current
    element?.addEventListener('wheel', wheel, { passive: false })
    return () => element?.removeEventListener('wheel', wheel)
  })
  useEffect(() => {
    if (!shown && !menu) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!host.current?.contains(target) && !tip.current?.contains(target) && !menuEl.current?.contains(target)) { hide(); setMenu(false) }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('.ov-search-panel')) return
      event.preventDefault(); event.stopPropagation()
      if (menu) { closeMenu(true); return }
      hide(); if (pinned) focusDial()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [shown, menu, pinned, !!scopedCoverage])
  useLayoutEffect(() => {
    if (!shown) return
    const place = () => {
      const box = center.current?.getBoundingClientRect(), height = tip.current?.offsetHeight ?? 80, width = Math.min(330, window.innerWidth - 16)
      if (box) setPosition({ left: Math.max(8, Math.min(window.innerWidth - width - 8, box.left + box.width / 2 - width / 2)), top: box.bottom + height + 10 < window.innerHeight ? box.bottom + 8 : Math.max(8, box.top - height - 8) })
    }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [shown, pinned, selected, scopedCoverage?.label])
  useLayoutEffect(() => {
    if (shown && pinned) tip.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [shown, pinned])
  useLayoutEffect(() => {
    if (!menu) return
    const place = () => {
      const box = host.current?.getBoundingClientRect(), height = menuEl.current?.offsetHeight ?? 260, width = menuEl.current?.offsetWidth || Math.min(220, window.innerWidth - 16)
      if (box) setMenuPos({ left: Math.max(8, Math.min(window.innerWidth - width - 8, box.left)), top: box.bottom + height + 10 < window.innerHeight ? box.bottom + 4 : Math.max(8, box.top - height - 4) })
    }
    place(); menuEl.current?.focus()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [menu])
  const move = (direction: number) => setActive(current => (current + direction + dialPatterns.length) % dialPatterns.length)
  const onMenuKey = (event: ReactKeyboardEvent) => {
    // The list is portaled, but React still bubbles its keys to the dial.
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); move(1) }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); move(-1) }
    else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); choose(dialPatterns[active]!, true) }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true) }
  }
  return <div className="ov-pattern-dial" ref={host} role="group" aria-label="Operational pattern dial" onKeyDown={event => {
    if (event.key === 'Enter' || (event.altKey && event.key === 'ArrowDown')) { event.preventDefault(); event.stopPropagation(); openMenu(); return }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); step(event.key === 'ArrowRight' ? 1 : -1) }
  }} onPointerDown={event => {
    if (menuEl.current?.contains(event.target as Node) || tip.current?.contains(event.target as Node)) return
    swiped.current = false
    if (menuRef.current) { setMenu(false); return }
    const primary = event.button === 0 || event.button == null
    if (primary) {
      held.current = false
      holdOrigin.current = { x: event.clientX, y: event.clientY }
      clearTimeout(holdTimer.current)
      // A completed hold owns the gesture: the later click and any swipe are suppressed.
      holdTimer.current = setTimeout(() => { holdOrigin.current = null; held.current = true; openMenu() }, HOLD_MS)
      stopTimer(); if (!pinned) setShown(false)
    }
    try { (event.target as HTMLElement).setPointerCapture?.(event.pointerId) } catch { /* a synthetic or already-released pointer cannot be captured */ }
    if (event.pointerType !== 'mouse') touch.current = { x: event.clientX, y: event.clientY }
  }} onPointerMove={event => {
    const origin = holdOrigin.current
    if (origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > HOLD_SLOP) stopHold()
  }} onPointerUp={event => {
    stopHold()
    const start = touch.current; touch.current = null
    if (held.current || !start) return
    const dx = event.clientX - start.x, dy = event.clientY - start.y
    if (Math.abs(dx) > 28 && Math.abs(dx) > Math.abs(dy) * 1.3) { swiped.current = true; step(dx < 0 ? 1 : -1) }
  }} onPointerCancel={() => { touch.current = null; stopHold() }} onContextMenu={event => event.preventDefault()} onClickCapture={event => {
    if (swiped.current || held.current) { swiped.current = false; held.current = false; event.preventDefault(); event.stopPropagation() }
  }}>
    <button type="button" className="ov-pattern-neighbor" aria-label={`Select ${label(previous)}`} onClick={() => choose(previous)}>{neighbor(previous)}</button>
    <button ref={center} type="button" className="ov-pattern-selected" aria-label={`${selectedName}, ${selectedCount}${scopedCoverage ? `, ${scopedCoverage.label}` : ''}. Show details`} aria-describedby="ov-pattern-description" aria-expanded={shown && pinned} aria-haspopup="dialog" aria-controls={shown && pinned ? 'ov-pattern-detail' : undefined} onMouseEnter={showLater} onMouseLeave={() => { stopTimer(); if (!pinned) setShown(false) }} onFocus={() => { if (!restoring.current) showLater() }} onBlur={() => { stopTimer(); if (!pinned) setShown(false) }} onClick={() => { stopTimer(); setPinned(!pinned); setShown(!pinned) }}><span className="ov-pattern-value"><span><strong>{selectedName}</strong> <b>{selectedCount}</b></span>{scopedCoverage && <small className="ov-pattern-coverage">{scopedCoverage.label}</small>}</span></button>
    <button type="button" className="ov-pattern-neighbor" aria-label={`Select ${label(next)}`} onClick={() => choose(next)}>{neighbor(next)}</button>
    <span id="ov-pattern-description" className="ov-sr-only">{selectedName}: {selectedReminder} Swipe sideways, scroll, or use Left and Right arrow keys to change pattern. Enter or Alt+Down lists every pattern; Space shows details.</span>
    {shown && !menu && createPortal(<div ref={tip} id={pinned ? 'ov-pattern-detail' : undefined} role={pinned ? 'dialog' : 'tooltip'} aria-label={pinned ? `${selectedName} pattern coverage` : undefined} className={`ov-pattern-tooltip${pinned ? ' ov-pattern-popover' : ''}`} style={position} onKeyDown={event => event.stopPropagation()}>{pinned ? <><strong>{confirmed} confirmed {selectedName.toLowerCase()}{scopedCoverage && ` · ${scopedCoverage.label}`}</strong><p>{scopedCoverage ? scopedCoverage.reasons[0] : selectedReminder}</p>{scopedCoverage && onInspectCoverage && <button type="button" onClick={() => { hide(); onInspectCoverage() }}>Show {scopedCoverage.unavailableCardIds.length} cards</button>}<button type="button" className="ov-pattern-close" onClick={() => { hide(); focusDial() }}>Close</button></> : `${selectedName}: ${selectedReminder}`}</div>, document.body)}
    {menu && createPortal(<div ref={menuEl} id="ov-pattern-list" role="listbox" aria-label="Operational patterns" aria-activedescendant={`ov-pattern-option-${dialPatterns[active]}`} tabIndex={-1} className="ov-pattern-menu" style={menuPos} onKeyDown={onMenuKey}>
      {dialPatterns.map(pattern => <button type="button" tabIndex={-1} key={pattern} id={`ov-pattern-option-${pattern}`} role="option" aria-selected={pattern === selected} aria-label={label(pattern)} title={reminder(pattern)} data-active={pattern === dialPatterns[active] ? 'true' : undefined} onMouseEnter={() => setActive(dialPatterns.indexOf(pattern))} onClick={() => choose(pattern, true)}><span>{dialNames[pattern]}</span><span className="ov-pattern-value"><small>{count(pattern)}</small>{counts[pattern].coverage && <small className="ov-pattern-coverage">{counts[pattern].coverage!.label}</small>}</span></button>)}
    </div>, document.body)}
  </div>
}

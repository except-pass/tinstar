import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { dialNames, dialPatterns, freshObservation, patternReminders, sceneWorkHealth, patternNames, patternDefinitions, type DialPattern, type Pattern } from '../shared/workHealth'
import { emptySearch } from '../shared/smartSearch'
import { isPlanned, type FloorScene, type PresentationAction, type PresentationState } from './presentation'
import { overviewGroups } from './overviewModel'
import type { PatternCoverage } from './overviewEvidence'
import './smartSearch.css'

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
    }]
  })) as Record<DialPattern | 'idle', { count: number; unknown: boolean; reasons: string[] }>
}

export function PatternDial({ scene, state, send, now, coverage, onInspectCoverage }: { coverage?: PatternCoverage | null; onInspectCoverage?: () => void; scene: FloorScene; state: PresentationState; send: (action: PresentationAction) => void; now: number }) {
  const selected: DialPattern | Pattern = state.search?.patterns[0] ?? 'all'
  const counts = useMemo(() => patternPreviews(scene, state, now), [scene, state, now])
  const selectedName = selected === 'idle' ? patternNames.idle : dialNames[selected]
  const selectedReminder = selected === 'idle' ? patternDefinitions.idle.rule : patternReminders[selected]
  const scopedCoverage = selected !== 'all' ? coverage : null
  const coverageDescription = scopedCoverage ? `Selected pattern could not evaluate ${scopedCoverage.unavailableCardIds.length} of ${scopedCoverage.total} visible cards; ${scopedCoverage.evaluated} evaluated. ${scopedCoverage.reasons.join('; ')}.` : ''
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
  const count = (pattern: DialPattern | Pattern) => counts[pattern].unknown ? counts[pattern].count ? `${counts[pattern].count}+` : '?' : String(counts[pattern].count)
  const label = (pattern: DialPattern | Pattern) => `${pattern === 'idle' ? patternNames.idle : dialNames[pattern]}, ${count(pattern)} matching tasks${counts[pattern].unknown ? ', incomplete evidence' : ''}`
  const reminder = (pattern: DialPattern) => `${patternReminders[pattern]}${counts[pattern].unknown ? ` ${counts[pattern].reasons.join('; ')}. ? means unknown; + means confirmed matches with incomplete coverage.` : ''}`
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
      hide(); if (scopedCoverage && pinned) focusDial()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape, true)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true) }
  }, [shown, menu, pinned, !!scopedCoverage])
  useLayoutEffect(() => {
    if (!shown) return
    const place = () => {
      const box = center.current?.getBoundingClientRect(), height = tip.current?.offsetHeight ?? 160, width = Math.min(330, window.innerWidth - 16)
      if (box) setPosition({ left: Math.max(8, Math.min(window.innerWidth - width - 8, box.left + box.width / 2 - width / 2)), top: box.bottom + height + 10 < window.innerHeight ? box.bottom + 8 : Math.max(8, box.top - height - 8) })
    }
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [shown, selected, coverageDescription])
  useLayoutEffect(() => {
    if (shown && pinned && scopedCoverage) tip.current?.querySelector<HTMLButtonElement>('button')?.focus()
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
    <button type="button" className="ov-pattern-neighbor" aria-label={`Select ${label(previous)}`} onClick={() => choose(previous)}><span>{dialNames[previous]}</span><small>{count(previous)}</small></button>
    <button ref={center} type="button" className="ov-pattern-selected" aria-label={`${label(selected)}. ${coverageDescription} Show explanation`} aria-describedby="ov-pattern-description" aria-expanded={menu || shown && pinned} aria-haspopup="listbox" aria-controls="ov-pattern-list" onMouseEnter={showLater} onMouseLeave={() => { stopTimer(); if (!pinned) setShown(false) }} onFocus={() => { if (!restoring.current) showLater() }} onBlur={() => { stopTimer(); if (!pinned) setShown(false) }} onClick={() => { stopTimer(); setPinned(!pinned); setShown(!pinned) }}><span className="ov-pattern-value"><span><strong>{selectedName}</strong> <small>{count(selected)}</small></span>{scopedCoverage && <small className="ov-pattern-coverage">{scopedCoverage.label}</small>}</span><span aria-hidden="true">ⓘ</span></button>
    <button type="button" className="ov-pattern-neighbor" aria-label={`Select ${label(next)}`} onClick={() => choose(next)}><span>{dialNames[next]}</span><small>{count(next)}</small></button>
    <span id="ov-pattern-description" className="ov-sr-only">{selectedReminder} {coverageDescription}{counts[selected].unknown ? ` ${counts[selected].reasons.join('; ')}. ? means unknown, + means confirmed matches with incomplete coverage.` : ''} Swipe sideways, scroll, or use Left and Right arrow keys to change pattern. Enter or Alt+Down lists every pattern.</span>
    {shown && !menu && createPortal(<div ref={tip} role={scopedCoverage && pinned ? 'dialog' : 'tooltip'} aria-label={scopedCoverage && pinned ? `${selectedName} pattern coverage` : undefined} className={`ov-pattern-tooltip${scopedCoverage && pinned ? ' ov-pattern-popover' : ''}`} style={position} onKeyDown={event => event.stopPropagation()}><strong>{selectedName} · {count(selected)} matching tasks</strong><p>{selectedReminder}</p>{scopedCoverage ? <><p>{coverageDescription}</p><p>Unknown is missing pattern evidence, not a confirmed problem or request for you.</p>{pinned && <button type="button" onClick={() => { hide(); onInspectCoverage?.() }}>Inspect {scopedCoverage.unavailableCardIds.length} {scopedCoverage.unavailableCardIds.length === 1 ? 'card' : 'cards'} with unknown pattern</button>}</> : counts[selected].unknown && <small>{counts[selected].reasons.join("; ")}. ? means unknown; + means confirmed matches with incomplete coverage.</small>}</div>, document.body)}
    {menu && createPortal(<div ref={menuEl} id="ov-pattern-list" role="listbox" aria-label="Operational patterns" aria-activedescendant={`ov-pattern-option-${dialPatterns[active]}`} tabIndex={-1} className="ov-pattern-menu" style={menuPos} onKeyDown={onMenuKey}>
      {dialPatterns.map(pattern => <button type="button" tabIndex={-1} key={pattern} id={`ov-pattern-option-${pattern}`} role="option" aria-selected={pattern === selected} aria-label={label(pattern)} title={reminder(pattern)} data-active={pattern === dialPatterns[active] ? 'true' : undefined} onMouseEnter={() => setActive(dialPatterns.indexOf(pattern))} onClick={() => choose(pattern, true)}><span>{dialNames[pattern]}</span><small>{count(pattern)}</small></button>)}
    </div>, document.body)}
  </div>
}

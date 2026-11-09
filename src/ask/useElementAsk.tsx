import { useEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { AskElement } from '../shared/ask'
import { buildElementSeed, readAskElement } from './element'
import type { AskSeed, AskSubject } from './semantic'

interface Hit { node: HTMLElement; element: AskElement; x: number; y: number; selection?: boolean }
/** One interaction layer for cards, table rows and Desk items. The floating
 * control is outside native buttons/links and never changes card geometry. */
export function useElementAsk(root: RefObject<HTMLElement>, subject: AskSubject, open?: (seed: AskSeed) => void) {
  const latest = useRef({ subject, open }); latest.current = { subject, open }
  const [hit, setHit] = useState<Hit | null>(null)
  const hitRef = useRef(hit); hitRef.current = hit
  const button = useRef<HTMLButtonElement>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout>>()
  const keep = () => clearTimeout(hideTimer.current)
  const hide = () => { keep(); hideTimer.current = setTimeout(() => setHit(null), 150) }
  const launch = (value: Hit) => { value.node.focus({ preventScroll: true }); value.node.dispatchEvent(new Event('tinstar:element-ask', { bubbles: true })); keep(); setHit(null); latest.current.open?.(buildElementSeed(latest.current.subject, value.element)) }
  const launchRef = useRef(launch); launchRef.current = launch
  useEffect(() => {
    const host = root.current
    if (!host || !latest.current.open) return
    host.dataset.elementAskSurface = ''
    let hold: ReturnType<typeof setTimeout> | undefined, start: { x: number; y: number } | null = null, suppressUntil = 0
    const owns = (node: Element) => node.closest('[data-element-ask-surface]') === host
    const fieldAt = (target: EventTarget | null) => {
      const element = target instanceof Element ? target : null
      if (element?.closest('input,select,textarea')) return null
      const field = element?.closest<HTMLElement>('[data-ask-field]')
      const control = element?.closest('a,button')
      // Unmarked action controls keep their native menus; fields inside the
      // Overview's card button still belong to the field itself.
      if (field && control && field !== control && field.contains(control)) return null
      return field && host.contains(field) && owns(field) ? field : null
    }
    const capture = (node: HTMLElement, element = readAskElement(node), selection = false): Hit => {
      const rect = selection ? window.getSelection()?.getRangeAt(0).getBoundingClientRect?.() ?? node.getBoundingClientRect() : node.getBoundingClientRect()
      return { node, element, x: Math.min(Math.max(8, rect.right - (selection ? 116 : 48)), window.innerWidth - (selection ? 124 : 56)), y: Math.min(Math.max(8, rect.top - 8), window.innerHeight - 40), selection }
    }
    const reveal = (event: Event) => { const field = fieldAt(event.target); if (field) { keep(); setHit(capture(field)) } }
    const cancelHold = () => { clearTimeout(hold); hold = undefined; start = null }
    const touchStart = (event: TouchEvent) => {
      cancelHold()
      const field = fieldAt(event.target), touch = event.touches[0]
      if (!field || event.touches.length !== 1 || !touch) return
      start = { x: touch.clientX, y: touch.clientY }
      hold = setTimeout(() => { suppressUntil = Date.now() + 1000; launchRef.current(capture(field)); cancelHold() }, 550)
    }
    const touchMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (event.touches.length !== 1 || !touch || start && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) cancelHold()
    }
    const selection = () => {
      const selected = window.getSelection()
      const node = (value: Node | null) => value instanceof Element ? value : value?.parentElement
      const from = node(selected?.anchorNode ?? null), to = node(selected?.focusNode ?? null)
      if (!selected || selected.isCollapsed || !from || !to || !host.contains(from) || !host.contains(to) || !owns(from) || !owns(to) || from.closest('input,textarea,select')) {
        setHit(previous => previous?.selection ? null : previous); return
      }
      const value = selected.toString().trim()
      if (!value) return
      const field = fieldAt(from)
      const element = field && field.contains(to) ? { ...readAskElement(field), value } : { field_name: 'selected_text', label: 'Selected text', value, type: 'generic' as const }
      keep(); setHit(capture(field ?? from as HTMLElement, element, true))
    }
    const click = (event: Event) => {
      const selected = window.getSelection()
      // A held touch or a text-selection drag must not also expand/navigate a card.
      if (Date.now() < suppressUntil || selected && !selected.isCollapsed && selected.anchorNode && host.contains(selected.anchorNode)) { event.preventDefault(); event.stopPropagation() }
    }
    const context = (event: Event) => {
      const field = fieldAt(event.target)
      if (Date.now() < suppressUntil || field) { event.preventDefault(); event.stopPropagation(); if (field && Date.now() >= suppressUntil) { const touched = !!start; cancelHold(); if (touched) suppressUntil = Date.now() + 1000; launchRef.current(capture(field)) } }
    }
    const key = (event: KeyboardEvent) => {
      const field = fieldAt(event.target)
      if (!field) return
      if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); event.stopPropagation(); launchRef.current(capture(field)) }
      if (event.key === 'Tab' && !event.shiftKey && hitRef.current?.node === field && button.current) { event.preventDefault(); button.current.focus() }
      if (event.key === 'Escape') setHit(null)
    }
    const leave = (event: FocusEvent | MouseEvent) => { if (!(event.relatedTarget instanceof Node) || !host.contains(event.relatedTarget) && !button.current?.contains(event.relatedTarget)) hide() }
    const scroll = () => { cancelHold(); const field = fieldAt(document.activeElement); setHit(field ? capture(field) : null) }
    host.addEventListener('mouseover', reveal)
    host.addEventListener('focusin', reveal)
    host.addEventListener('mouseout', leave)
    host.addEventListener('focusout', leave)
    host.addEventListener('keydown', key)
    host.addEventListener('touchstart', touchStart, { passive: true })
    host.addEventListener('touchmove', touchMove, { passive: true })
    host.addEventListener('touchend', cancelHold)
    host.addEventListener('touchcancel', cancelHold)
    host.addEventListener('click', click, true)
    host.addEventListener('contextmenu', context, true)
    document.addEventListener('selectionchange', selection)
    window.addEventListener('scroll', scroll, true)
    window.addEventListener('resize', scroll)
    return () => {
      cancelHold(); keep(); delete host.dataset.elementAskSurface
      host.removeEventListener('mouseover', reveal); host.removeEventListener('focusin', reveal)
      host.removeEventListener('mouseout', leave); host.removeEventListener('focusout', leave)
      host.removeEventListener('keydown', key)
      host.removeEventListener('touchstart', touchStart); host.removeEventListener('touchmove', touchMove)
      host.removeEventListener('touchend', cancelHold); host.removeEventListener('touchcancel', cancelHold)
      host.removeEventListener('click', click, true); host.removeEventListener('contextmenu', context, true)
      document.removeEventListener('selectionchange', selection)
      window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', scroll)
    }
  }, [root, !!open])
  return hit && open ? createPortal(<button ref={button} type="button" className="ask-element-affordance" style={{ left: hit.x, top: hit.y }}
    aria-label={hit.selection ? 'Ask about this' : `Ask about ${hit.element.label}: ${hit.element.value}`}
    title={hit.selection ? 'Ask about this' : `Ask about ${hit.element.label}`}
    onMouseEnter={keep} onMouseLeave={hide} onFocus={keep} onBlur={hide}
    onMouseDown={event => event.preventDefault()} onClick={event => { event.stopPropagation(); launch(hit) }}
    onKeyDown={event => { if (event.key === 'Escape') { hit.node.focus(); setHit(null) } }}>
    {hit.selection ? 'Ask about this' : <><span aria-hidden="true">?</span><span className="ask-element-word"> Ask</span></>}
  </button>, document.body) : null
}

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { clampDeskWidth, defaultDeskWidth, deskWidthLimit, loadDeskPreferences, minimumDeskWidth, saveDeskPreferences } from './deskPreferences'
import './desk.css'

export function DeskRail({ openRequest, unread, attention, onClose, tools, children }: {
  openRequest: number; unread: number; attention: number; onClose: () => void; tools?: ReactNode | ((closeMobile: () => void) => ReactNode); children: ReactNode
}) {
  const [preferences, setPreferences] = useState(loadDeskPreferences)
  const [narrow, setNarrow] = useState(() => window.matchMedia?.('(max-width:850px)').matches ?? false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [available, setAvailable] = useState(window.innerWidth - 62)
  const host = useRef<HTMLDivElement>(null), panel = useRef<HTMLElement>(null), trigger = useRef<HTMLButtonElement>(null), closeButton = useRef<HTMLButtonElement>(null)
  const drag = useRef<{ id: number; x: number; width: number } | null>(null)
  const width = clampDeskWidth(preferences.width, available)
  const visible = narrow ? mobileOpen : !preferences.collapsed
  const open = () => setPreferences(value => value.collapsed ? { ...value, collapsed: false } : value)
  // Explicit open requests (queue navigation, PR header) never remount the inbox.
  const handledRequest = useRef(0)
  useEffect(() => { if (openRequest !== handledRequest.current) { handledRequest.current = openRequest; if (narrow) setMobileOpen(true); else setPreferences(value => ({ ...value, collapsed: false })) } }, [openRequest, narrow])
  useEffect(() => { saveDeskPreferences(preferences) }, [preferences])
  useLayoutEffect(() => {
    const update = () => setAvailable(host.current?.parentElement?.clientWidth || window.innerWidth - 62)
    const query = window.matchMedia?.('(max-width:850px)')
    const reflow = () => { setNarrow(query?.matches ?? window.innerWidth <= 850); update() }
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    if (host.current?.parentElement) observer?.observe(host.current.parentElement)
    query?.addEventListener?.('change', reflow); window.addEventListener('resize', reflow); update()
    return () => { observer?.disconnect(); query?.removeEventListener?.('change', reflow); window.removeEventListener('resize', reflow) }
  }, [])
  const previousVisible = useRef(visible), previousNarrow = useRef(narrow)
  useLayoutEffect(() => {
    if (visible && narrow && (!previousVisible.current || !previousNarrow.current)) closeButton.current?.focus({ preventScroll: true })
    if (!visible && panel.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true })
    previousVisible.current = visible; previousNarrow.current = narrow
  }, [visible, narrow])
  const close = () => {
    if (narrow) setMobileOpen(false)
    else setPreferences(value => ({ ...value, collapsed: true }))
    trigger.current?.focus({ preventScroll: true }); onClose()
  }
  const changeWidth = (next: number) => setPreferences(value => ({ ...value, width: clampDeskWidth(next, available) }))
  const countLabel = `${unread} unread answers, ${attention} need attention`
  return <div ref={host} className={`desk-host${narrow ? ' is-narrow' : ''}${visible ? ' is-open' : ' is-closed'}`} style={{ '--desk-width': `${width}px` } as React.CSSProperties}>
    <button ref={trigger} type="button" className="desk-trigger" aria-controls="global-desk" aria-expanded={visible} aria-label={`Open Your desk, ${countLabel}`} onClick={() => { if (narrow) setMobileOpen(true); else open() }}>Your desk{unread + attention > 0 && <span aria-hidden="true">{unread + attention}</span>}</button>
    {narrow && visible && <button className="desk-backdrop" type="button" aria-label="Close Your desk" onClick={close} />}
    <div className="desk-divider" hidden={narrow || !visible} role="separator" tabIndex={0} aria-label="Resize Your desk" aria-orientation="vertical" aria-controls="global-desk" aria-valuemin={minimumDeskWidth} aria-valuemax={Math.floor(deskWidthLimit(available))} aria-valuenow={Math.round(width)} aria-valuetext={`${Math.round(width)} pixels`} onDoubleClick={() => changeWidth(defaultDeskWidth)} onKeyDown={event => {
      const next = event.key === 'ArrowLeft' ? width + 16 : event.key === 'ArrowRight' ? width - 16 : event.key === 'Home' ? minimumDeskWidth : event.key === 'End' ? deskWidthLimit(available) : null
      if (next !== null) { event.preventDefault(); changeWidth(next) }
    }} onPointerDown={event => {
      if (event.button !== 0) return
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { id: event.pointerId, x: event.clientX, width }
    }} onPointerMove={event => { if (drag.current?.id === event.pointerId) changeWidth(drag.current.width + drag.current.x - event.clientX) }} onPointerUp={event => {
      if (drag.current?.id !== event.pointerId) return
      drag.current = null
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }} />
    <aside id="global-desk" ref={panel} className="global-desk ov-desk" hidden={!visible} role={narrow ? 'dialog' : undefined} aria-modal={narrow && visible ? true : undefined} aria-label="Your desk" onKeyDown={event => {
      if (!narrow) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
      if (event.key === 'Tab') {
        const controls = [...panel.current?.querySelectorAll<HTMLElement>('button,a[href],input,textarea,select,summary,[tabindex="0"]') ?? []].filter(element => !element.closest('[hidden]') && !element.matches(':disabled') && element.getClientRects().length)
        const first = controls[0], last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }
    }}>
      <header><small className="ov-eyebrow">YOU / ONE INBOX</small><div className="ov-desk-title"><h2>Your desk</h2><span className="ov-desk-tools">{typeof tools === 'function' ? tools(() => { if (narrow) close() }) : tools}<button ref={closeButton} type="button" aria-label={narrow ? 'Close Your desk' : 'Collapse Your desk'} onClick={close}>{narrow ? 'Close' : '−'}</button></span></div>
        {(unread + attention > 0) && <small className="desk-counts">{countLabel}</small>}
        <details className="desk-options"><summary>Desk size</summary><button type="button" onClick={() => setPreferences({ width: defaultDeskWidth, collapsed: false })}>Reset Desk size</button><span>Drag the divider or use its arrow keys.</span></details>
      </header>{children}
    </aside>
  </div>
}

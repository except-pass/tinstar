import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { directNeighbors, emptySearch } from '../shared/smartSearch'
import { semanticId, type FloorScene, type PresentationAction, type PresentationState, type Target } from './presentation'
import { saveOverviewDensity, type OverviewDensity } from './overviewDensity'

interface Snapshot {
  state: PresentationState
  roots: Target[]
  density: OverviewDensity
  anchor?: string
  offset: number
  scroll: number
  scrollLeft: number
  details: string[]
  focus?: string
}

/** One temporary focus lens over the existing reducer, with semantic restore. */
export function useSearchSession({ scene, state, send, canvas, root, roots, setRoots, density, setDensity, details, setDetails }: {
  scene: FloorScene | null
  state: PresentationState; send: (action: PresentationAction) => void; canvas: RefObject<HTMLDivElement>; root: RefObject<HTMLDivElement>
  details: string[]; setDetails: Dispatch<SetStateAction<string[]>>
  roots: Target[]; setRoots: Dispatch<SetStateAction<Target[]>>; density: OverviewDensity; setDensity: Dispatch<SetStateAction<OverviewDensity>>
}) {
  const [open, setOpen] = useState(false)
  const snapshot = useRef<Snapshot | null>(null), restorePending = useRef<Snapshot | null>(null)
  const historyEntries = useRef(0), ignorePop = useRef(false)
  const leaveHistory = (count: number) => {
    if (!count) return
    historyEntries.current = Math.max(0, historyEntries.current - count)
    ignorePop.current = true; window.history.go(-count)
  }
  const begin = () => {
    if (!snapshot.current) {
      const viewport = canvas.current?.parentElement
      const top = viewport?.getBoundingClientRect().top ?? 0
      const anchor = [...canvas.current?.querySelectorAll<HTMLElement>('.ov-item[data-semantic-id]') ?? []].find(element => element.getBoundingClientRect().bottom > top)
      snapshot.current = { state, roots, density, details, anchor: anchor?.dataset.semanticId, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, scroll: viewport?.scrollTop ?? 0, scrollLeft: viewport?.scrollLeft ?? 0,
        focus: document.activeElement?.closest<HTMLElement>('[data-semantic-id]')?.dataset.semanticId }
    }
    if (!open && window.matchMedia?.('(max-width:850px)').matches) {
      // A same-document entry lets mobile Back dismiss the transient layer.
      // Restricted history degrades to the visible close control and Escape.
      try { window.history.pushState({ ...window.history.state, tinstarSearch: true }, '', window.location.href); historyEntries.current++ } catch { /* navigation remains usable */ }
    }
    setOpen(true)
  }
  const dismiss = (back = true) => {
    if (back) leaveHistory(Math.min(1, historyEntries.current))
    setOpen(false)
    if (!state.searchFocus) snapshot.current = null
  }
  const restore = (clear = false, back = true) => {
    if (back) leaveHistory(historyEntries.current)
    const saved = snapshot.current
    if (saved) {
      const { selection, collapsed, navigation, exceptionsOnly, roadmapExpanded, organizer, statusFilter, donutFilter, linksVisible, arrangement, sort } = saved.state
      send({ type: 'restore-search-view', view: { search: clear ? emptySearch() : saved.state.search ?? emptySearch(), selection, collapsed, navigation, exceptionsOnly, roadmapExpanded, organizer, statusFilter, donutFilter, linksVisible, arrangement, sort } })
      setRoots(saved.roots); setDetails(saved.details); setDensity(saved.density); saveOverviewDensity(saved.density)
      restorePending.current = saved
    } else if (clear) send({ type: 'clear-search' })
    snapshot.current = null; setOpen(false)
  }
  useLayoutEffect(() => {
    const saved = restorePending.current
    if (!saved || !canvas.current) return
    const elements = [...canvas.current.querySelectorAll<HTMLElement>('.ov-item[data-semantic-id]')]
    const anchor = elements.find(element => element.dataset.semanticId === saved.anchor)
    const viewport = canvas.current.parentElement!
    viewport.scrollTop = anchor ? viewport.scrollTop + anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - saved.offset : saved.scroll
    viewport.scrollLeft = saved.scrollLeft
    const focus = elements.find(element => element.dataset.semanticId === saved.focus) ?? root.current?.querySelector<HTMLElement>('.ov-search-trigger')
    focus?.focus({ preventScroll: true })
    const frame = requestAnimationFrame(() => { if (restorePending.current === saved) restorePending.current = null })
    return () => cancelAnimationFrame(frame)
  })
  useLayoutEffect(() => {
    if (!state.searchReveal) return
    const key = semanticId(state.searchReveal)
    const element = [...canvas.current?.querySelectorAll<HTMLElement>('.ov-item[data-semantic-id]') ?? []].find(element => element.dataset.semanticId === key)
    element?.scrollIntoView({ block: 'center', behavior: 'instant' }); element?.focus({ preventScroll: true })
  }, [state.searchReveal, canvas])
  // Only the Overview owns this shortcut; terminal iframe input stays local.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); begin() }
      else if (event.key === 'Escape' && snapshot.current) { event.preventDefault(); event.stopPropagation(); if (open) dismiss(); else restore() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    const back = () => {
      if (ignorePop.current) { ignorePop.current = false; return }
      if (!snapshot.current) return
      historyEntries.current = Math.max(0, historyEntries.current - 1)
      if (open) dismiss(false); else restore(false, false)
    }
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  })
  return { dismiss, isRestoring: () => !!restorePending.current, open, active: !!snapshot.current, begin, restore: () => restore(), clear: () => restore(true), apply: () => setOpen(false), choose: (target: Target, targets: Target[] = [target]) => {
    send({ type: 'reveal-search', target, targets }); setRoots(targets)
    const cluster = scene ? directNeighbors(scene, targets) : new Set([semanticId(target)])
    setDetails(values => values.filter(id => !cluster.has(id))); setOpen(false)
  } }
}

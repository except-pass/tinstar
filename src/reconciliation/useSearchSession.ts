import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { WorkspaceHistory } from '../ask/workspaceHistory'
import { directNeighbors, emptySearch } from '../shared/smartSearch'
import { targetExists, semanticId, type FloorScene, type PresentationAction, type PresentationState, type Target } from './presentation'
import { saveOverviewDensity, type OverviewDensity } from './overviewDensity'

interface ViewSnapshot {
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
export function useSearchSession({ views, active, scene, state, send, canvas, root, roots, setRoots, density, setDensity, details, setDetails }: {
  views?: WorkspaceHistory
  active: boolean
  scene: FloorScene | null
  state: PresentationState; send: (action: PresentationAction) => void; canvas: RefObject<HTMLDivElement>; root: RefObject<HTMLDivElement>
  details: string[]; setDetails: Dispatch<SetStateAction<string[]>>
  roots: Target[]; setRoots: Dispatch<SetStateAction<Target[]>>; density: OverviewDensity; setDensity: Dispatch<SetStateAction<OverviewDensity>>
}) {
  const [open, setOpen] = useState(false)
  const snapshot = useRef<ViewSnapshot | null>(null), restorePending = useRef<ViewSnapshot | null>(null)
  const [historySession] = useState(() => crypto.randomUUID())
  const historyEntries = useRef(0), ignorePop = useRef(false)
  const ownedHistoryDepth = useCallback(() => {
    const entry = window.history.state?.tinstarSearch
    return entry?.session === historySession ? entry.depth as number : 0
  }, [historySession])
  useLayoutEffect(() => {
    historyEntries.current = active ? ownedHistoryDepth() : 0
  }, [active, ownedHistoryDepth])
  const leaveHistory = (count: number) => {
    const depth = ownedHistoryDepth()
    const steps = Math.min(count, depth)
    historyEntries.current = depth - steps
    if (!steps) return
    ignorePop.current = true; window.history.go(-steps)
  }
  const captureBaseline = (): ViewSnapshot => {
    const viewport = canvas.current?.parentElement
    const top = viewport?.getBoundingClientRect().top ?? 0
    const anchor = [...canvas.current?.querySelectorAll<HTMLElement>('.ov-item[data-semantic-id]') ?? []].find(element => element.getBoundingClientRect().bottom > top)
    return { state, roots, density, details, anchor: anchor?.dataset.semanticId, offset: anchor ? anchor.getBoundingClientRect().top - top : 0, scroll: viewport?.scrollTop ?? 0, scrollLeft: viewport?.scrollLeft ?? 0,
      focus: document.activeElement?.closest<HTMLElement>('[data-semantic-id]')?.dataset.semanticId }
  }
  const remember = () => { if (!snapshot.current) snapshot.current = captureBaseline() }
  const begin = (withHistory = true) => {
    remember()
    if (withHistory && !open && window.matchMedia?.('(max-width:850px)').matches) {
      // A same-document entry lets mobile Back dismiss the transient layer.
      // Restricted history degrades to the visible close control and Escape.
      historyEntries.current = ownedHistoryDepth()
      try { views?.capture(); window.history.pushState({ ...window.history.state, tinstarWorkspace: undefined, tinstarSearch: { session: historySession, depth: historyEntries.current + 1 } }, '', window.location.href); historyEntries.current++; views?.navigated() } catch { /* navigation remains usable */ }
    }
    setOpen(true)
  }
  const dismiss = (back = true) => {
    if (back) leaveHistory(Math.min(1, ownedHistoryDepth()))
    setOpen(false)
    if (!state.searchFocus) snapshot.current = null
  }
  const restoreView = (saved: ViewSnapshot, clear = false) => {
    const { searchReveal, searchFocus, selection, collapsed, navigation, exceptionsOnly, roadmapExpanded, organizer, statusFilter, donutFilter, linksVisible, arrangement, sort } = saved.state
    send({ type: 'restore-search-view', view: { search: clear ? emptySearch() : saved.state.search ?? emptySearch(), searchReveal: searchReveal ?? null, searchFocus, selection, collapsed, navigation, exceptionsOnly, roadmapExpanded, organizer, statusFilter, donutFilter, linksVisible, arrangement, sort } })
    setRoots(saved.roots); setDetails(saved.details); setDensity(saved.density); saveOverviewDensity(saved.density)
    restorePending.current = saved
  }
  const restore = (clear = false, back = true) => {
    if (back) leaveHistory(ownedHistoryDepth())
    if (snapshot.current) restoreView(snapshot.current, clear)
    else if (clear) send({ type: 'clear-search' })
    snapshot.current = null; setOpen(false)
  }
  // A dial/filter action can clear focus outside the palette. End its temporary
  // session too, so a later Escape/Back cannot restore the superseded view.
  useLayoutEffect(() => {
    if (!active || open || state.searchFocus || !snapshot.current || restorePending.current) return
    leaveHistory(ownedHistoryDepth())
    snapshot.current = null
  }, [active, open, state.searchFocus])
  useLayoutEffect(() => {
    const saved = restorePending.current
    if (!active || !saved || !canvas.current) return
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
    if (!active || restorePending.current || !state.searchReveal) return
    const key = semanticId(state.searchReveal)
    const element = [...canvas.current?.querySelectorAll<HTMLElement>('.ov-item[data-semantic-id]') ?? []].find(element => element.dataset.semanticId === key)
    element?.scrollIntoView({ block: 'center', behavior: 'instant' }); element?.focus({ preventScroll: true })
  }, [active, state.searchReveal, canvas])
  // Only the Overview owns this shortcut; terminal iframe input stays local.
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); begin() }
      else if (event.key === 'Escape' && snapshot.current) { event.preventDefault(); event.stopPropagation(); if (open) dismiss(); else restore() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const onPop = useRef<() => void>(() => {})
  onPop.current = () => {
    const previousDepth = historyEntries.current
    historyEntries.current = ownedHistoryDepth()
    if (ignorePop.current) { ignorePop.current = false; return }
    if (!active || !snapshot.current || previousDepth <= historyEntries.current) return
    if (open) dismiss(false); else restore(false, false)
  }
  useEffect(() => {
    // App also renders on popstate. Keep this listener installed while that
    // render commits, rather than removing it midway through event dispatch.
    const back = () => onPop.current()
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  }, [])
  return { remember, dismiss, isRestoring: () => !!restorePending.current, open, active: !!snapshot.current, begin, restore: () => restore(), clear: () => restore(true), choose: (target: Target, targets: Target[] = [target]) => {
    if (!scene || [target, ...targets].some(item => !targetExists(scene, item, state))) return false
    remember()
    leaveHistory(Math.max(0, ownedHistoryDepth() - 1))
    send({ type: 'reveal-search', target, targets }); setRoots(targets)
    const cluster = directNeighbors(scene, targets)
    setDetails(values => values.filter(id => !cluster.has(id))); setOpen(false)
    return true
  } }
}

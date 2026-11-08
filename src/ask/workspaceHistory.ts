import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

type Section = 'overview' | 'pulls' | 'releases'
interface Snapshot { section: Section; view: unknown }
interface Adapter { capture: () => unknown }

/** Snapshots belong to normal browser entries, not a second navigation stack. */
export function useWorkspaceHistory(section: Section | null) {
  const active = useRef(section); active.current = section
  const adapters = useRef(new Map<Section, Adapter>()), saved = useRef(new Map<Section, unknown>())
  const [restoration, setRestoration] = useState(() => ({ revision: 0, snapshot: history.state?.tinstarWorkspace as Snapshot | undefined }))
  const [canBack, setCanBack] = useState(!!history.state?.tinstarAskReturn)
  const register = useCallback((key: Section, adapter: Adapter) => {
    adapters.current.set(key, adapter)
    return () => { if (adapters.current.get(key) === adapter) adapters.current.delete(key) }
  }, [])
  const frame = useRef<number | null>(null)
  const cancelCapture = useCallback(() => { if (frame.current !== null) cancelAnimationFrame(frame.current); frame.current = null }, [])
  useEffect(() => cancelCapture, [cancelCapture])
  const capture = useCallback(() => {
    cancelCapture()
    const key = active.current, adapter = key && adapters.current.get(key)
    if (!key || !adapter) return
    const view = adapter.capture(); saved.current.set(key, view)
    try {
      const snapshot = { section: key, view }
      if (JSON.stringify(history.state?.tinstarWorkspace) !== JSON.stringify(snapshot)) history.replaceState({ ...history.state, tinstarWorkspace: snapshot }, '', location.href)
    } catch { /* Restricted history still permits ordinary navigation. */ }
  }, [cancelCapture])
  const scheduleCapture = useCallback((key: Section) => {
    if (active.current !== key || frame.current !== null) return
    frame.current = requestAnimationFrame(() => { frame.current = null; if (active.current === key) capture() })
  }, [capture])
  const pop = useCallback(() => {
    cancelCapture()
    setCanBack(!!history.state?.tinstarAskReturn)
    setRestoration(previous => ({ revision: previous.revision + 1, snapshot: history.state?.tinstarWorkspace }))
  }, [cancelCapture])
  const navigated = useCallback(() => { cancelCapture(); setCanBack(!!history.state?.tinstarAskReturn); setRestoration(previous => ({ revision: previous.revision + 1, snapshot: undefined })) }, [cancelCapture])
  return { register, capture, scheduleCapture, pop, navigated, restoration, canBack, back: () => history.back(), saved: (key: Section) => saved.current.get(key) }
}
export type WorkspaceHistory = ReturnType<typeof useWorkspaceHistory>

/** Each section owns its small, serializable view; callbacks stay out of history. */
export function useViewSnapshot<T>(history: WorkspaceHistory | undefined, section: Section, capture: () => T, restore: (view: T) => void, ready = true) {
  const latest = useRef({ capture, restore }); latest.current = { capture, restore }
  const revision = useRef<number | null>(null)
  useLayoutEffect(() => history?.register(section, { capture: () => latest.current.capture() }), [history?.register, section])
  useLayoutEffect(() => {
    if (!history || !ready) return
    if (revision.current === history.restoration.revision) { history.scheduleCapture(section); return }
    const entry = history.restoration.snapshot
    const view = entry?.section === section ? entry.view : revision.current === null ? history.saved(section) : undefined
    revision.current = history.restoration.revision
    if (view !== undefined) latest.current.restore(view as T)
    else history.scheduleCapture(section)
  }, [history, section, ready])
  useEffect(() => {
    if (!history || !ready) return
    const capturePosition = () => history.scheduleCapture(section)
    document.addEventListener('scroll', capturePosition, true)
    return () => document.removeEventListener('scroll', capturePosition, true)
  }, [history, section, ready])
}

export interface ScrollPosition { top: number; left: number; anchor?: string; offset: number; focus?: string }
const rowKey = (row: HTMLElement, attribute: string) => JSON.stringify([row.closest('[data-view-group]')?.getAttribute('data-view-group'), row.getAttribute(attribute)])
export function captureScroll(viewport: HTMLElement | null, attribute: string): ScrollPosition {
  const top = viewport?.getBoundingClientRect().top ?? 0
  const rows = [...viewport?.querySelectorAll<HTMLElement>(`[${attribute}]`) ?? []]
  const anchor = rows.find(row => row.getBoundingClientRect().bottom > top)
  const focused = rows.find(row => row === document.activeElement || row.contains(document.activeElement))
  return { top: viewport?.scrollTop ?? 0, left: viewport?.scrollLeft ?? 0, anchor: anchor && rowKey(anchor, attribute), offset: anchor ? anchor.getBoundingClientRect().top - top : 0, focus: focused && rowKey(focused, attribute) }
}
export function restoreScroll(viewport: HTMLElement | null, attribute: string, saved: ScrollPosition) {
  if (!viewport) return
  const rows = [...viewport.querySelectorAll<HTMLElement>(`[${attribute}]`)]
  const anchor = rows.find(row => rowKey(row, attribute) === saved.anchor)
  viewport.scrollTop = anchor ? viewport.scrollTop + anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top - saved.offset : saved.top
  viewport.scrollLeft = saved.left
  rows.find(row => rowKey(row, attribute) === saved.focus)?.focus({ preventScroll: true })
}

/** Wait for the restored state and its rows to commit, then restore once. */
export function useScrollRestore(viewport: () => HTMLElement | null, attribute: string, ready: boolean, generation?: number) {
  const pending = useRef<{ position: ScrollPosition; generation?: number } | null>(null)
  const [, setRevision] = useState(0)
  useLayoutEffect(() => {
    if (!ready || !pending.current) return
    const saved = pending.current
    // A newer route cancels a position waiting for its rows to commit.
    if (saved.generation !== generation) { pending.current = null; return }
    const frame = requestAnimationFrame(() => { if (pending.current === saved) { restoreScroll(viewport(), attribute, saved.position); pending.current = null } })
    return () => cancelAnimationFrame(frame)
  })
  return { restore: (position: ScrollPosition) => { pending.current = { position, generation }; setRevision(value => value + 1) } }
}

import { useCallback, useLayoutEffect, useRef, useState } from 'react'

type Section = 'overview' | 'pulls' | 'releases'
interface Snapshot { section: Section; view: unknown }
interface Entry { snapshot?: Snapshot; resolvedOrigin?: string }
interface Adapter { capture: () => unknown; ready: () => boolean }
export const workspaceHistoryStorageKey = 'tinstar.workspace-history.v1'

function loadEntries(): Map<string, Entry> {
  try { return new Map(JSON.parse(sessionStorage.getItem(workspaceHistoryStorageKey) ?? '[]')) } catch { return new Map() }
}
function entryId() {
  if (typeof history.state?.tinstarWorkspaceEntry === 'string') return history.state.tinstarWorkspaceEntry as string
  const id = crypto.randomUUID()
  try { history.replaceState({ ...history.state, tinstarWorkspaceEntry: id }, '', location.href) } catch { /* Restricted history still permits ordinary navigation. */ }
  return id
}

/** Snapshots belong to normal browser entries, not a second navigation stack. */
export function useWorkspaceHistory(section: Section | null) {
  const active = useRef(section); active.current = section
  const [initial] = useState(() => ({ id: entryId(), entries: loadEntries() }))
  const currentId = useRef(initial.id), entries = useRef(initial.entries)
  const adapters = useRef(new Map<Section, Adapter>()), saved = useRef(new Map<Section, unknown>())
  const [restoration, setRestoration] = useState(() => ({ revision: 0, snapshot: entries.current.get(initial.id)?.snapshot }))
  const [canBack, setCanBack] = useState(!!history.state?.tinstarAskReturn)
  const persist = useCallback(() => {
    try { sessionStorage.setItem(workspaceHistoryStorageKey, JSON.stringify([...entries.current])) } catch {}
  }, [])
  const register = useCallback((key: Section, adapter: Adapter) => {
    adapters.current.set(key, adapter)
    return () => { if (adapters.current.get(key) === adapter) adapters.current.delete(key) }
  }, [])
  const capture = useCallback(() => {
    const key = active.current, adapter = key && adapters.current.get(key)
    if (!key || !adapter || !adapter.ready()) return
    const view = adapter.capture(); saved.current.set(key, view)
    entries.current.set(currentId.current, { ...entries.current.get(currentId.current), snapshot: { section: key, view } })
    persist()
  }, [persist])
  const pop = useCallback(() => {
    capture()
    currentId.current = entryId()
    setCanBack(!!history.state?.tinstarAskReturn)
    const snapshot = entries.current.get(currentId.current)?.snapshot
    setRestoration(previous => ({ revision: previous.revision + 1, snapshot }))
  }, [capture])
  const navigated = useCallback(() => {
    currentId.current = entryId()
    entries.current.delete(currentId.current)
    persist()
    setCanBack(!!history.state?.tinstarAskReturn)
    setRestoration(previous => ({ revision: previous.revision + 1, snapshot: undefined }))
  }, [persist])
  useLayoutEffect(() => {
    window.addEventListener('popstate', pop, true)
    window.addEventListener('pagehide', capture)
    window.addEventListener('beforeunload', capture)
    return () => {
      window.removeEventListener('popstate', pop, true)
      window.removeEventListener('pagehide', capture)
      window.removeEventListener('beforeunload', capture)
    }
  }, [pop, capture])
  const originResolved = (key: string) => entries.current.get(currentId.current)?.resolvedOrigin === key
  const resolveOrigin = (key: string) => {
    entries.current.set(currentId.current, { ...entries.current.get(currentId.current), resolvedOrigin: key })
    persist()
  }
  return { register, capture, navigated, originResolved, resolveOrigin, restoration, canBack, back: () => history.back(), saved: (key: Section) => saved.current.get(key) }
}
export type WorkspaceHistory = ReturnType<typeof useWorkspaceHistory>

/** Each section owns its small, serializable view; callbacks stay out of history. */
export function useViewSnapshot<T>(history: WorkspaceHistory | undefined, section: Section, capture: () => T, restore: (view: T) => void, ready = true) {
  const latest = useRef({ capture, restore, ready }); latest.current = { capture, restore, ready }
  const revision = useRef<number | null>(null)
  const entry = history?.restoration.snapshot
  const view = entry?.section === section ? entry.view : revision.current === null ? history?.saved(section) : undefined
  const restoring = !!history && ready && revision.current !== history.restoration.revision && view !== undefined
  useLayoutEffect(() => history?.register(section, { capture: () => latest.current.capture(), ready: () => latest.current.ready }), [history?.register, section])
  useLayoutEffect(() => {
    if (!history || !ready || revision.current === history.restoration.revision) return
    revision.current = history.restoration.revision
    if (view !== undefined) latest.current.restore(view as T)
  }, [history, ready, view])
  return restoring
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
    restoreScroll(viewport(), attribute, saved.position)
    pending.current = null
  })
  return { restore: (position: ScrollPosition) => { pending.current = { position, generation }; setRevision(value => value + 1) } }
}

import { useCallback, useLayoutEffect, useRef, useState } from 'react'

type Section = 'overview' | 'pulls' | 'releases' | 'decisions'
interface View { query?: string; sort?: string; filter?: unknown; group?: unknown }
interface Snapshot extends View { section: Section }
interface Adapter { capture: () => View }

export function useWorkspaceHistory(section: Section | null) {
  const active = useRef(section); active.current = section
  const adapters = useRef(new Map<Section, Adapter>())
  const [restoration, setRestoration] = useState(() => ({ revision: 0, snapshot: history.state?.tinstarWorkspace as Snapshot | undefined }))
  const pendingRestore = useRef(!!restoration.snapshot)
  const [canBack, setCanBack] = useState(!!history.state?.tinstarAskReturn)
  const register = useCallback((key: Section, adapter: Adapter) => {
    adapters.current.set(key, adapter)
    return () => { if (adapters.current.get(key) === adapter) adapters.current.delete(key) }
  }, [])
  const capture = useCallback(() => {
    const key = active.current, adapter = key && adapters.current.get(key)
    if (!key || !adapter || pendingRestore.current) return
    const { query, sort, filter, group } = adapter.capture()
    try { history.replaceState({ ...history.state, tinstarWorkspace: { section: key, query, sort, filter, group } }, '', location.href) } catch {}
  }, [])
  const pop = useCallback(() => {
    const snapshot = history.state?.tinstarWorkspace as Snapshot | undefined
    pendingRestore.current = !!snapshot
    setCanBack(!!history.state?.tinstarAskReturn)
    setRestoration(previous => ({ revision: previous.revision + 1, snapshot }))
  }, [])
  const navigated = useCallback(() => {
    pendingRestore.current = false
    try { history.replaceState({ ...history.state, tinstarWorkspace: undefined }, '', location.href) } catch {}
    setCanBack(!!history.state?.tinstarAskReturn)
    setRestoration(previous => ({ revision: previous.revision + 1, snapshot: undefined }))
  }, [])
  useLayoutEffect(() => {
    window.addEventListener('popstate', pop, true)
    window.addEventListener('pagehide', capture)
    return () => {
      window.removeEventListener('popstate', pop, true)
      window.removeEventListener('pagehide', capture)
    }
  }, [pop, capture])
  return { register, capture, navigated, restoration, applied: () => { pendingRestore.current = false }, canBack, back: () => history.back() }
}
export type WorkspaceHistory = ReturnType<typeof useWorkspaceHistory>

export function useViewSnapshot<T extends View>(history: WorkspaceHistory | undefined, section: Section, capture: () => T, restore: (view: T) => void, ready = true) {
  const latest = useRef({ capture, restore }); latest.current = { capture, restore }
  const revision = useRef<number | null>(null)
  const entry = history?.restoration.snapshot
  const restoring = !!history && ready && revision.current !== history.restoration.revision && entry?.section === section
  useLayoutEffect(() => history?.register(section, { capture: () => latest.current.capture() }), [history?.register, section])
  useLayoutEffect(() => {
    if (!history || !ready || revision.current === history.restoration.revision) return
    revision.current = history.restoration.revision
    if (entry?.section === section) { latest.current.restore(entry as unknown as T); history.applied() }
  }, [history, ready, entry, section])
  return restoring
}

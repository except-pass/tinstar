import { useCallback, useEffect, useRef } from 'react'
import { apiFetch } from '../../apiClient'
import { useServerEvents } from '../../hooks/useServerEvents'
import { useWidgetId } from './widgetIdContext'
import type { PluginWidgetInstance, Run } from '../../domain/types'

const DEBOUNCE_MS = 250
const RUN_PREFIX = 'run-'

/** Persistent state for a plugin widget. Two backing stores depending on where the
 *  widget is mounted:
 *   - At a session's run node (widgetId `run-<id>`, a session-view): backed by the
 *     run's `viewData`, persisted via PATCH /api/runs/:id.
 *   - Anywhere else (a standalone plugin-widget instance): backed by the
 *     plugin-widget-instance store, persisted via PATCH /api/plugin-widgets/:id. */
export function usePluginWidgetData<T>(): [T | null, (next: T) => void] {
  const widgetId = useWidgetId()                       // throws outside a widget shell
  const { state, addOptimistic } = useServerEvents()
  // One debounce timer covers both branches: `widgetId` (hence `isRunNode`) is
  // fixed for the widget's lifetime, so the two stores never interleave on one timer.
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const isRunNode = widgetId.startsWith(RUN_PREFIX)
  const runId = isRunNode ? widgetId.slice(RUN_PREFIX.length) : ''

  const run = isRunNode ? ((state.runs ?? []).find((r: Run) => r.id === runId) ?? null) : null
  const instance = isRunNode ? null : ((state.pluginWidgets ?? []).find((p: PluginWidgetInstance) => p.id === widgetId) ?? null)

  const data = (isRunNode ? (run?.viewData ?? null) : (instance?.data ?? null)) as T | null

  // Keep latest backing record in a ref so setData identity is stable across edits.
  const runRef = useRef(run); runRef.current = run
  const instanceRef = useRef(instance); instanceRef.current = instance

  const setData = useCallback((next: T) => {
    if (isRunNode) {
      const cur = runRef.current
      if (!cur) {
        // eslint-disable-next-line no-console
        console.warn(`[session-view] setData called before run ${runId} exists`)
        return
      }
      addOptimistic('run', { ...cur, viewData: next })
      if (pendingTimer.current) clearTimeout(pendingTimer.current)
      pendingTimer.current = setTimeout(() => {
        apiFetch(`/api/runs/${runId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ viewData: next }),
        }).catch(err => {
          // eslint-disable-next-line no-console
          console.error(`[session-view] PATCH failed for run ${runId}:`, err)
        })
      }, DEBOUNCE_MS)
      return
    }

    const inst = instanceRef.current
    if (!inst) {
      // eslint-disable-next-line no-console
      console.warn(`[plugin-widget] setData called before instance exists for ${widgetId}`)
      return
    }
    addOptimistic('pluginWidget', { ...inst, data: next, updatedAt: new Date().toISOString() })
    if (pendingTimer.current) clearTimeout(pendingTimer.current)
    pendingTimer.current = setTimeout(() => {
      apiFetch(`/api/plugin-widgets/${widgetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: next }),
      }).catch(err => {
        // eslint-disable-next-line no-console
        console.error(`[plugin-widget] PATCH failed for ${widgetId}:`, err)
      })
    }, DEBOUNCE_MS)
  }, [widgetId, isRunNode, runId, addOptimistic])

  // Flush pending debounce on unmount (accept losing the last <250ms of edits;
  // the browser won't reliably await an async PATCH during teardown).
  useEffect(() => () => {
    if (pendingTimer.current) clearTimeout(pendingTimer.current)
  }, [])

  return [data, setData]
}

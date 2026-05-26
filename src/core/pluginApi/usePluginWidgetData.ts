import { useCallback, useEffect, useRef } from 'react'
import { apiFetch } from '../../apiClient'
import { useServerEvents } from '../../hooks/useServerEvents'
import { useWidgetId } from './widgetIdContext'
import type { PluginWidgetInstance } from '../../domain/types'

const DEBOUNCE_MS = 250

export function usePluginWidgetData<T>(): [T | null, (next: T) => void] {
  const widgetId = useWidgetId()                       // throws outside a widget shell — matches the existing api.hotkeys pattern
  const { state, addOptimistic } = useServerEvents()
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const instance = (state.pluginWidgets ?? []).find((p: PluginWidgetInstance) => p.id === widgetId) ?? null
  const data = (instance?.data ?? null) as T | null

  const setData = useCallback((next: T) => {
    if (!instance) {
      // The host hasn't created this instance yet (unlikely from inside a mounted
      // widget). Log and bail so the plugin doesn't silently lose writes.
      // eslint-disable-next-line no-console
      console.warn(`[plugin-widget] setData called before instance exists for ${widgetId}`)
      return
    }
    // Optimistic update so the React tree re-renders immediately.
    addOptimistic('pluginWidget', { ...instance, data: next, updatedAt: new Date().toISOString() })

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
  }, [widgetId, instance, addOptimistic])

  // Flush pending debounce on unmount
  useEffect(() => () => {
    if (pendingTimer.current) {
      // We accept losing the last <250ms of edits on unmount. The browser
      // won't reliably await an async PATCH during teardown. Documented in spec.
      clearTimeout(pendingTimer.current)
    }
  }, [])

  return [data, setData]
}

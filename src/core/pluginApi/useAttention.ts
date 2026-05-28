import { useCallback, useEffect, useRef } from 'react'
import { apiFetch } from '../../apiClient'
import { useServerEvents } from '../../hooks/useServerEvents'
import { useWidgetId } from './widgetIdContext'
import type { PluginWidgetInstance, AttentionState, AttentionLevel } from '../../domain/types'

const DEBOUNCE_MS = 250

interface AttentionInput {
  level: AttentionLevel
  reason: string
}

export function useAttention(): [AttentionState | null, (next: AttentionInput | null) => void] {
  const widgetId = useWidgetId()
  const { state, addOptimistic } = useServerEvents()
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const instance = (state.pluginWidgets ?? []).find((p: PluginWidgetInstance) => p.id === widgetId) ?? null
  const attention = instance?.attention ?? null

  const setAttention = useCallback((next: AttentionInput | null) => {
    if (!instance) {
      // eslint-disable-next-line no-console
      console.warn(`[useAttention] called before instance exists for ${widgetId}`)
      return
    }
    const optimisticAttention: AttentionState | undefined = next === null
      ? undefined
      : { ...next, setAt: new Date().toISOString() }
    addOptimistic('pluginWidget', { ...instance, attention: optimisticAttention })

    if (pendingTimer.current) clearTimeout(pendingTimer.current)
    pendingTimer.current = setTimeout(() => {
      apiFetch(`/api/plugin-widgets/${widgetId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attention: next }),
      }).catch((err: unknown) => {
        // eslint-disable-next-line no-console
        console.error(`[useAttention] PATCH failed for ${widgetId}:`, err)
      })
    }, DEBOUNCE_MS)
  }, [widgetId, instance, addOptimistic])

  useEffect(() => () => {
    if (pendingTimer.current) clearTimeout(pendingTimer.current)
  }, [])

  return [attention, setAttention]
}

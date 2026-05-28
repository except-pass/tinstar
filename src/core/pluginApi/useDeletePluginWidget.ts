import { useCallback } from 'react'
import { apiFetch } from '../../apiClient'
import { useWidgetId } from './widgetIdContext'

export function useDeletePluginWidget(): () => Promise<void> {
  const id = useWidgetId()
  return useCallback(async () => {
    const r = await apiFetch(`/api/plugin-widgets/${id}`, { method: 'DELETE' })
    if (!r.ok) throw new Error(`delete plugin widget ${id} failed: ${r.status}`)
  }, [id])
}

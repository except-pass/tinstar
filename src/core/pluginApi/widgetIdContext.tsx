// src/core/pluginApi/widgetIdContext.tsx
//
// Per-widget identity context. The host wraps each plugin widget render
// in <WidgetIdProvider id={node.id}>; plugin-API hooks that need to know
// "which widget am I" (e.g. usePeers, publishCapability) read this.
import { createContext, useContext, type ReactNode } from 'react'

const WidgetIdContext = createContext<string | null>(null)

export function WidgetIdProvider({ id, children }: { id: string; children: ReactNode }) {
  return <WidgetIdContext.Provider value={id}>{children}</WidgetIdContext.Provider>
}

export function useWidgetId(): string {
  const id = useContext(WidgetIdContext)
  if (!id) throw new Error('useWidgetId requires WidgetIdProvider — mount inside a host widget shell')
  return id
}

// src/core/constellationCapabilities.ts
//
// In-memory capability registry used by the plugin-API constellations
// peer/RPC surface. Widgets publish named capabilities; peers in the same
// constellation can discover and invoke them.
//
// Process-wide singleton — capabilities live for the lifetime of the
// widget that published them (typically a useEffect cleanup unpublishes).

type CapabilityHandler = (args: unknown) => Promise<unknown>

interface RegistryShape {
  publish(widgetId: string, name: string, handler: CapabilityHandler): () => void
  unpublish(widgetId: string, name: string): void
  capabilitiesOf(widgetId: string): string[]
  invoke(widgetId: string, name: string, args: unknown): Promise<unknown>
  subscribe(listener: () => void): () => void
  clearAll(): void
}

function createRegistry(): RegistryShape {
  const store = new Map<string, Map<string, CapabilityHandler>>()
  const listeners = new Set<() => void>()

  const notify = () => { for (const l of listeners) l() }

  const registry: RegistryShape = {
    publish(widgetId, name, handler) {
      let m = store.get(widgetId)
      if (!m) { m = new Map(); store.set(widgetId, m) }
      m.set(name, handler)
      notify()
      return () => registry.unpublish(widgetId, name)
    },
    unpublish(widgetId, name) {
      const m = store.get(widgetId)
      if (!m) return
      m.delete(name)
      if (m.size === 0) store.delete(widgetId)
      notify()
    },
    capabilitiesOf(widgetId) {
      const m = store.get(widgetId)
      return m ? Array.from(m.keys()) : []
    },
    async invoke(widgetId, name, args) {
      const handler = store.get(widgetId)?.get(name)
      if (!handler) throw new Error(`capability not published: ${widgetId}/${name}`)
      return handler(args)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    clearAll() {
      store.clear()
      notify()
    },
  }
  return registry
}

export const capabilityRegistry = createRegistry()

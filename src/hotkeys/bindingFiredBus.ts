// src/hotkeys/bindingFiredBus.ts
// Lightweight pub/sub — context router emits here; HotkeysSidebar subscribes to flash the row.

type Listener = (key: string) => void
const listeners = new Set<Listener>()

export function onBindingFired(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function emitBindingFired(key: string): void {
  listeners.forEach(fn => fn(key))
}

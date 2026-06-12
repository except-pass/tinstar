// Per-node pin-capture registry — the "front door" through which a plugin
// declares "what's under this point on my widget" at pin-placement time.
//
// Mirrors the pinsBridge / capabilityRegistry pattern: a module-level map keyed
// by host node id. A plugin widget registers its capture fn via
// api.pins.useProvideCapture (createApi); the host shell looks it up at the drop
// point in handlePinPlaceUp. When a node has no registered capture (every native
// widget), the host falls back to the generic captureWidgetContext util.
//
// The capture fn returns the opaque context blob to merge into the pin:
//   - the browser returns a FLAT blob `{ url, target?, docX, docY }` (its own
//     content-glued format that BrowserPinLayer renders from), or undefined
//     (not laid out / cross-origin without a target);
//   - the native fallback nests under `{ capture: { label, tag, text? } }`.
// The host treats it as opaque — it just spreads `{ ...(blob ? { context: blob } : {}) }`.

export type PinCaptureFn = (point: { clientX: number; clientY: number }) => Record<string, unknown> | undefined

const registry = new Map<string, PinCaptureFn>()

export function registerPinCapture(nodeId: string, fn: PinCaptureFn): void {
  registry.set(nodeId, fn)
}

export function unregisterPinCapture(nodeId: string): void {
  registry.delete(nodeId)
}

export function getPinCapture(nodeId: string): PinCaptureFn | undefined {
  return registry.get(nodeId)
}

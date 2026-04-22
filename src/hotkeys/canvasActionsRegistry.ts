// src/hotkeys/canvasActionsRegistry.ts
//
// Module-level registry that lets widget action handlers reach canvas-level
// capabilities (camera + layout mutation) without prop-drilling or a React
// context. Matches the pattern used by actionHandlerRegistry.ts and
// bindingFiredBus.ts.
//
// InfiniteCanvas registers a `fit` impl in a useEffect; widget action
// handlers call fitWidgetToViewport(id) when their 'fit-viewport' action
// fires.

interface CanvasActions {
  fit: (nodeId: string) => void
}

let impl: CanvasActions | null = null

/**
 * Register the canvas actions implementation. Returns a cleanup function.
 * The cleanup only clears the impl if it's still the one we registered —
 * defensive against late cleanup after a later registration has overwritten.
 */
export function registerCanvasActions(fns: CanvasActions): () => void {
  impl = fns
  return () => {
    if (impl === fns) impl = null
  }
}

/** Fit the widget identified by nodeId to the viewport. No-op if no impl is registered. */
export function fitWidgetToViewport(nodeId: string): void {
  impl?.fit(nodeId)
}

/** Test-only: reset module state between tests. */
export function _resetCanvasActionsRegistry(): void {
  impl = null
}

// src/hotkeys/actionHandlerRegistry.ts

/** A widget's action handler. Returning `false` means "I did not handle that" — the
 *  router then leaves the keystroke alone (no preventDefault, no confirmation flash)
 *  so the key isn't swallowed by a binding that was inert in the current state.
 *  Returning anything else (including `undefined`) means handled, which is what
 *  every pre-existing handler does implicitly. */
type ActionHandler = (action: string) => void | boolean

const handlers = new Map<string, ActionHandler>()

export function registerActionHandler(widgetId: string, fn: ActionHandler): void {
  handlers.set(widgetId, fn)
}

export function deregisterActionHandler(widgetId: string): void {
  handlers.delete(widgetId)
}

/** Dispatch and report whether the widget claimed the action. A widget with no
 *  registered handler counts as handled, preserving the pre-existing behavior. */
export function dispatchAction(widgetId: string, action: string): boolean {
  const fn = handlers.get(widgetId)
  if (!fn) return true
  return fn(action) !== false
}

type FlourishFn = () => void
const flourishHandlers = new Map<string, FlourishFn>()
const scanHandlers = new Map<string, FlourishFn>()

export function registerFlourishHandler(widgetId: string, fn: FlourishFn): void {
  flourishHandlers.set(widgetId, fn)
}

export function deregisterFlourishHandler(widgetId: string): void {
  flourishHandlers.delete(widgetId)
  scanHandlers.delete(widgetId)
}

/** Full Hollywood Hit — bloom + scan + ripple (navigation / widget selection) */
export function triggerWidgetFlourish(widgetId: string): void {
  flourishHandlers.get(widgetId)?.()
}

export function registerScanHandler(widgetId: string, fn: FlourishFn): void {
  scanHandlers.set(widgetId, fn)
}

/** Scan line only — transient chord action or direct binding invocation */
export function triggerWidgetScan(widgetId: string): void {
  scanHandlers.get(widgetId)?.()
}

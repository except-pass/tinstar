// src/hotkeys/actionHandlerRegistry.ts

type ActionHandler = (action: string) => void

const handlers = new Map<string, ActionHandler>()

export function registerActionHandler(widgetId: string, fn: ActionHandler): void {
  handlers.set(widgetId, fn)
}

export function deregisterActionHandler(widgetId: string): void {
  handlers.delete(widgetId)
}

export function dispatchAction(widgetId: string, action: string): void {
  handlers.get(widgetId)?.(action)
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

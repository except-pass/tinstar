/** Dispatched by the inbox (or anywhere) to ask the canvas to pan to, raise,
 *  flash, and focus a widget by id. The InfiniteCanvas listens for this event. */
export interface WidgetFlashFocusDetail {
  widgetId: string                  // run id (without `run-` prefix) OR plugin widget id
  source: 'run' | 'plugin'
}

export function dispatchFlashFocus(detail: WidgetFlashFocusDetail): void {
  window.dispatchEvent(new CustomEvent<WidgetFlashFocusDetail>('widget:flash-focus', { detail }))
}

// Central registry for tinstar:* custom DOM events that flow over window.
// Before this module, both emit and listen sides wrote raw string literals —
// a typo silently broke a feature with no compile-time signal.
//
// One event NOT covered here: 'tinstar:open-linked-file' is dispatched on a
// specific element (e.currentTarget.dispatchEvent) and bubbles up through
// the DOM tree, not via window. It uses CustomEvent natively at the call
// sites and is documented in the type map for visibility but not migrated.

import { useEffect, useRef } from 'react'

export interface TinstarWindowEventMap {
  /** File-watcher notification re-dispatched from the SSE bridge. */
  'tinstar:file_watch': unknown
  /** NATS traffic frame re-dispatched from the SSE bridge. */
  'tinstar:nats_traffic': unknown
  /** Telemetry HUD payload re-dispatched from the SSE bridge. */
  'tinstar:telemetry:hud': unknown
  /** Canvas viewport state re-dispatched from the SSE bridge. */
  'tinstar:canvas:viewport': unknown
  /** Projects-on-disk changed re-dispatched from the SSE bridge. */
  'tinstar:projects_changed': unknown
  /** Agent pushed a workspace file — the dashboard auto-downloads it. */
  'tinstar:download:push': { url: string; filename: string }
  /** Commit delta — no payload, just a notification. */
  'tinstar:commit-delta': undefined
  /** Hidden-runs set changed by a non-React writer in THIS tab (e.g. the SSE
   *  run-removed prune). Same-tab signal only — cross-tab rides native `storage`. */
  'tinstar:hidden-runs-changed': undefined
}

export type TinstarWindowEventName = keyof TinstarWindowEventMap

/** Const-asserted event names so string-literal call sites (e.g. inside
 *  useEffect blocks that share refs and can't easily switch to useWindowEvent)
 *  can still get compile-time-checked names: `addEventListener(EV.nats_traffic, ...)`.
 *  A typo on EV.foo fails type-check; a typo on 'tinstar:nats_trafic' does not. */
export const EV = {
  fileWatch: 'tinstar:file_watch',
  natsTraffic: 'tinstar:nats_traffic',
  telemetryHud: 'tinstar:telemetry:hud',
  canvasViewport: 'tinstar:canvas:viewport',
  projectsChanged: 'tinstar:projects_changed',
  downloadPush: 'tinstar:download:push',
  commitDelta: 'tinstar:commit-delta',
  hiddenRunsChanged: 'tinstar:hidden-runs-changed',
} as const satisfies Record<string, TinstarWindowEventName>

export function dispatchWindowEvent<K extends TinstarWindowEventName>(
  name: K,
  detail: TinstarWindowEventMap[K],
): void {
  // For payload-less events, use plain Event so listeners read .detail as
  // undefined (CustomEvent normalizes undefined → null, which surprises
  // every consumer that ever has to write a falsy check).
  if (detail === undefined) {
    window.dispatchEvent(new Event(name))
    return
  }
  window.dispatchEvent(new CustomEvent<TinstarWindowEventMap[K]>(name, { detail }))
}

/** React hook: subscribes for the lifetime of the component, unsubscribes on
 *  unmount. Handler receives the typed detail payload directly.
 *
 *  Uses a ref-stable wrapper so callers can pass inline arrow handlers without
 *  re-attaching the underlying window listener on every render. */
export function useWindowEvent<K extends TinstarWindowEventName>(
  name: K,
  handler: (detail: TinstarWindowEventMap[K]) => void,
): void {
  const handlerRef = useRef(handler)
  useEffect(() => { handlerRef.current = handler }, [handler])
  useEffect(() => {
    const wrapper = (e: Event) => {
      // window.dispatchEvent of `new Event(name)` arrives as an `Event` (not
      // CustomEvent); plain Event.detail is undefined, matching the type map.
      const ce = e as CustomEvent<TinstarWindowEventMap[K]>
      handlerRef.current(ce.detail as TinstarWindowEventMap[K])
    }
    window.addEventListener(name, wrapper)
    return () => window.removeEventListener(name, wrapper)
  }, [name])
}

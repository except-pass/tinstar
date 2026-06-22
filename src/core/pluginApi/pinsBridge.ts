import type { Pin } from '@tinstar/plugin-api'

/** Mutators published by the host-mounted PinsBridge for the active space.
 *  api.pins.create/update/remove are NOT hooks, so they call through this
 *  module-level ref. Unlike the events `getBridge()` (which lazily constructs
 *  and never returns null), this is a host-mounted ref: the <PinsBridge>
 *  component (inside the active-space ConstellationProvider) keeps it pointed at
 *  the live usePinSet mutators, and it is null whenever no space is active (or
 *  during teardown) — hence callers must null-guard and warn. */
export interface PinsBridgeMutators {
  create(pin: Pin): void
  update(id: string, fn: (p: Pin) => Pin): void
  remove(id: string): void
}

let mutators: PinsBridgeMutators | null = null

export function setPinsBridge(next: PinsBridgeMutators | null): void {
  mutators = next
}

export function getPinsBridge(): PinsBridgeMutators | null {
  return mutators
}
